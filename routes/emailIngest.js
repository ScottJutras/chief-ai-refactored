'use strict';

// routes/emailIngest.js
// POST /api/email-ingest — Postmark inbound parse webhook.
//
// Flow:
//   1. Verify POSTMARK_WEBHOOK_TOKEN (header X-Postmark-Token)
//   2. Deduplicate by postmark_msg_id → early-exit if already processed
//   3. Resolve tenant from email_capture_token embedded in To address
//      e.g. To: abc123def456@in.usechiefos.com  →  token = "abc123def456"
//   4. For each attachment: decode base64 → SHA-256 dedup check → upload to Storage
//      → create intake_item (receipt_image / pdf_document / voice_note)
//   5. If email body looks like a lead inquiry: create email_lead intake_item
//   6. Write email_ingest_events record
//   7. Return 200 always (Postmark retries on non-2xx)
//
// All writes are idempotent. The primary dedup is on email_ingest_events.postmark_msg_id UNIQUE.
// Per-attachment dedup uses SHA-256 of raw attachment content against intake_items.dedupe_hash.

const express = require('express');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const router = express.Router();

// Parse up to 25 MB (Postmark max email size with attachments)
router.use(express.json({ limit: '25mb' }));

// ── Config ────────────────────────────────────────────────────────────────────

const WEBHOOK_TOKEN    = process.env.POSTMARK_WEBHOOK_TOKEN || '';
const STORAGE_BUCKET   = process.env.INTAKE_UPLOADS_BUCKET || 'intake-uploads';
const INBOUND_DOMAIN   = process.env.EMAIL_INBOUND_DOMAIN  || 'in.usechiefos.com';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

function adminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, ''),
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Pull the email_capture_token out of a comma-separated address list. */
function extractToken(addressField) {
  if (!addressField) return null;
  // Handles: plain "token@domain", "Name <token@domain>", comma-separated multiples
  const candidates = addressField.split(',').map(a => a.trim());
  for (const addr of candidates) {
    const match = addr.match(/<([^>]+)>/) || addr.match(/([^\s]+@[^\s]+)/);
    const email = match ? match[1].toLowerCase() : '';
    const localPart = email.split('@')[0];
    const domain    = email.split('@')[1] || '';
    if (domain === INBOUND_DOMAIN && localPart && /^[0-9a-f]{10,}$/i.test(localPart)) {
      return localPart.toLowerCase();
    }
  }
  return null;
}

/** Classify attachment MIME type into an intake kind. */
function attachmentKind(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (m.startsWith('image/'))         return 'receipt_image';
  if (m === 'application/pdf')        return 'pdf_document';
  if (m.startsWith('audio/') ||
      /\.(mp3|m4a|wav|aac|ogg|webm|wma)$/i.test(m)) return 'voice_note';
  return 'unknown';
}

const LEAD_SIGNALS = [
  /\bquote\b/i, /\bestimate\b/i, /\bprice\b/i, /\bhow much\b/i,
  /\bavailable\b/i, /\bhire\b/i, /\binterested\b/i, /\bproject\b/i,
  /\bservice\b/i, /\bget started\b/i, /\bschedule\b/i, /\bappointment\b/i,
  /\bcontact\b/i, /\bquestion\b/i, /\bcall me\b/i,
];
const EXPENSE_SIGNALS = [
  /\breceipt\b/i, /\binvoice\b/i, /\bcharge\b/i, /\bpurchase\b/i,
  /\border\b/i, /\bpayment\b/i, /\bamount due\b/i,
];

function classifyBody(subject, body) {
  const text = `${subject || ''} ${body || ''}`;
  const expenseScore = EXPENSE_SIGNALS.filter(r => r.test(text)).length;
  const leadScore    = LEAD_SIGNALS.filter(r => r.test(text)).length;
  if (expenseScore >= 2) return 'expense';
  if (leadScore    >= 1) return 'lead';
  return 'unknown';
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post('/api/email-ingest', async (req, res) => {
  // Always 200 — Postmark retries on anything else
  const respond = (msg = 'ok') => res.status(200).json({ ok: true, msg });

  try {
    // ── 1. Auth ───────────────────────────────────────────────────────────────
    if (WEBHOOK_TOKEN) {
      const provided = (req.headers['x-postmark-token'] || '').trim();
      if (!provided || provided !== WEBHOOK_TOKEN) {
        console.warn('[EMAIL_INGEST] invalid webhook token');
        return respond('unauthorized');
      }
    }

    const body = req.body || {};
    const postmarkMsgId = String(body.MessageID || '').trim();
    if (!postmarkMsgId) return respond('missing MessageID');

    // ── 2. Primary dedup ──────────────────────────────────────────────────────
    const existing = await pool.query(
      `SELECT id FROM public.email_ingest_events WHERE postmark_msg_id = $1 LIMIT 1`,
      [postmarkMsgId]
    ).catch(() => null);
    if (existing?.rows?.length) {
      console.info('[EMAIL_INGEST] duplicate, skipping', { postmarkMsgId });
      return respond('duplicate');
    }

    // ── 3. Resolve tenant from email_capture_token ────────────────────────────
    const toFields = [body.To, body.Cc, body.Bcc].filter(Boolean).join(',');
    const token = extractToken(toFields);

    if (!token) {
      console.warn('[EMAIL_INGEST] no capture token in To/Cc/Bcc', { to: body.To });
      // Record the failed attempt then bail
      await pool.query(
        `INSERT INTO public.email_ingest_events
           (tenant_id, owner_id, postmark_msg_id, from_email, subject,
            detected_kind, attachment_count, processing_status, source_type)
         VALUES ('00000000-0000-0000-0000-000000000000', 'unknown',
                 $1, $2, $3, 'unknown', 0, 'failed', 'forwarded_receipt')
         ON CONFLICT (postmark_msg_id) DO NOTHING`,
        [postmarkMsgId, String(body.From || ''), String(body.Subject || '')]
      ).catch(() => null);
      return respond('no_token');
    }

    const tenantRow = await pool.query(
      `SELECT id, owner_id FROM public.chiefos_tenants
       WHERE email_capture_token = $1 LIMIT 1`,
      [token]
    ).catch(() => null);

    if (!tenantRow?.rows?.length) {
      console.warn('[EMAIL_INGEST] token not found', { token });
      return respond('token_not_found');
    }

    const { id: tenantId, owner_id: ownerId } = tenantRow.rows[0];

    // ── 4. Classify email ─────────────────────────────────────────────────────
    const subject      = String(body.Subject    || '').trim();
    const textBody     = String(body.TextBody   || '').trim();
    const attachments  = Array.isArray(body.Attachments) ? body.Attachments : [];
    const fromEmail    = String(body.From       || '').trim();
    const bodyKind     = classifyBody(subject, textBody);
    const supabase     = adminSupabase();

    // ── 5. Create one intake_batch per email ──────────────────────────────────
    const { data: batch, error: batchErr } = await supabase
      .from('intake_batches')
      .insert({
        tenant_id: tenantId,
        owner_id:  ownerId,
        kind:      'email_batch',
        status:    'uploaded',
        total_items: attachments.length + (bodyKind === 'lead' ? 1 : 0),
      })
      .select('id')
      .single();

    if (batchErr || !batch?.id) {
      console.error('[EMAIL_INGEST] batch create failed', batchErr?.message);
      return respond('batch_create_failed');
    }

    const batchId = batch.id;
    let itemsCreated = 0;

    // ── 6. Process attachments ────────────────────────────────────────────────
    for (const att of attachments) {
      try {
        const filename    = String(att.Name        || 'attachment').trim();
        const mimeType    = String(att.ContentType || 'application/octet-stream').toLowerCase();
        const contentB64  = String(att.Content     || '');
        if (!contentB64) continue;

        const buffer     = Buffer.from(contentB64, 'base64');
        const hash       = sha256(buffer);
        const kind       = attachmentKind(mimeType);
        const draftType  = (kind === 'voice_note') ? 'unknown' : 'expense';

        // Attachment-level dedup: check SHA-256 against confirmed/persisted items
        const dupe = await pool.query(
          `SELECT id FROM public.intake_items
           WHERE tenant_id = $1 AND dedupe_hash = $2
             AND status IN ('confirmed','persisted')
           LIMIT 1`,
          [tenantId, hash]
        ).catch(() => null);

        const itemStatus = dupe?.rows?.length ? 'duplicate' : 'uploaded';
        const dupeOfId   = dupe?.rows?.[0]?.id || null;

        // Upload to Storage (even duplicates — we store them for evidence)
        const ext        = filename.includes('.') ? filename.split('.').pop().replace(/[^a-z0-9]/gi, '') : 'bin';
        const storagePath = `${tenantId}/${batchId}/${crypto.randomUUID()}.${ext}`;

        const upload = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, buffer, {
            contentType: mimeType,
            upsert: false,
          });

        if (upload.error) {
          console.warn('[EMAIL_INGEST] storage upload failed', { filename, error: upload.error.message });
          continue;
        }

        // Create intake_item
        const { data: item, error: itemErr } = await supabase
          .from('intake_items')
          .insert({
            batch_id:              batchId,
            tenant_id:             tenantId,
            owner_id:              ownerId,
            kind,
            status:                itemStatus,
            storage_bucket:        STORAGE_BUCKET,
            storage_path:          storagePath,
            source_filename:       filename,
            mime_type:             mimeType,
            source_hash:           hash,
            dedupe_hash:           hash,
            draft_type:            draftType,
            duplicate_of_item_id:  dupeOfId,
            confidence_score:      kind === 'unknown' ? 0.05 : 0.12,
            source_email_id:       postmarkMsgId,
          })
          .select('id')
          .single();

        if (itemErr || !item?.id) {
          console.warn('[EMAIL_INGEST] item insert failed', itemErr?.message);
          continue;
        }

        // Create intake_item_draft
        const validationFlags = [];
        if (kind === 'receipt_image')  validationFlags.push('ocr_pending');
        if (kind === 'pdf_document')   validationFlags.push('pdf_text_empty');
        if (kind === 'voice_note')     validationFlags.push('voice_transcript_low_confidence');
        if (kind === 'unknown')        validationFlags.push('unsupported_file_type');
        if (dupeOfId)                  validationFlags.push('possible_duplicate_content');

        await supabase
          .from('intake_item_drafts')
          .insert({
            intake_item_id:   item.id,
            tenant_id:        tenantId,
            owner_id:         ownerId,
            draft_type:       draftType,
            amount_cents:     null,
            vendor:           fromEmail || null,
            description:      subject || null,
            raw_model_output: {
              pipeline_version: 'email-ingest-v1',
              source: 'email',
              from_email: fromEmail,
              subject,
              attachment_name: filename,
            },
            validation_flags: validationFlags,
          });

        itemsCreated++;
      } catch (attErr) {
        console.warn('[EMAIL_INGEST] attachment processing error', attErr?.message);
      }
    }

    // ── 7. Create email_lead item for inquiry bodies (no/few attachments) ─────
    if (bodyKind === 'lead' && textBody.length > 20) {
      try {
        const { data: leadItem } = await supabase
          .from('intake_items')
          .insert({
            batch_id:        batchId,
            tenant_id:       tenantId,
            owner_id:        ownerId,
            kind:            'email_lead',
            status:          'pending_review',
            storage_bucket:  STORAGE_BUCKET,
            storage_path:    '',          // no file, text only
            source_filename: `Lead: ${subject || fromEmail}`.slice(0, 255),
            mime_type:       'text/plain',
            source_hash:     sha256(Buffer.from(postmarkMsgId + textBody)),
            dedupe_hash:     sha256(Buffer.from(postmarkMsgId + textBody)),
            draft_type:      'unknown',
            transcript_text: textBody.slice(0, 8000),
            confidence_score: 0.70,
            source_email_id: postmarkMsgId,
          })
          .select('id')
          .single();

        if (leadItem?.id) {
          await supabase
            .from('intake_item_drafts')
            .insert({
              intake_item_id:   leadItem.id,
              tenant_id:        tenantId,
              owner_id:         ownerId,
              draft_type:       'unknown',
              vendor:           fromEmail || null,
              description:      `${subject}\n\n${textBody}`.slice(0, 2000),
              raw_model_output: {
                pipeline_version: 'email-ingest-v1',
                source: 'email_lead',
                from_email: fromEmail,
                subject,
                body_preview: textBody.slice(0, 500),
              },
              validation_flags: ['lead_inquiry_requires_review'],
            });
          itemsCreated++;
        }
      } catch (leadErr) {
        console.warn('[EMAIL_INGEST] lead item creation failed', leadErr?.message);
      }
    }

    // ── 8. Write email_ingest_events ──────────────────────────────────────────
    await pool.query(
      `INSERT INTO public.email_ingest_events
         (tenant_id, owner_id, postmark_msg_id, from_email, subject,
          detected_kind, attachment_count, processing_status, source_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'processed', $8)
       ON CONFLICT (postmark_msg_id) DO NOTHING`,
      [
        tenantId,
        ownerId,
        postmarkMsgId,
        fromEmail,
        subject,
        bodyKind,
        attachments.length,
        attachments.length > 0 ? 'forwarded_receipt' : 'lead_form',
      ]
    ).catch(() => null);

    // ── 9. Update batch total_items to actual count ───────────────────────────
    await supabase
      .from('intake_batches')
      .update({ total_items: itemsCreated, status: 'pending_review' })
      .eq('tenant_id', tenantId)
      .eq('id', batchId);

    console.info('[EMAIL_INGEST] processed', {
      postmarkMsgId, tenantId, ownerId,
      attachments: attachments.length, itemsCreated, bodyKind,
    });

    return respond('processed');

  } catch (err) {
    console.error('[EMAIL_INGEST] fatal error', err?.message);
    return res.status(200).json({ ok: false, error: err?.message });
  }
});

module.exports = router;
