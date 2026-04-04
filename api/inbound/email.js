// api/inbound/email.js
// Postmark inbound email webhook. Receives forwarded receipts and contact form leads,
// resolves the tenant from the capture token in the To: address, and dispatches
// to the appropriate handler.
//
// Auth: Postmark is configured to POST to /api/inbound/email?token=POSTMARK_INBOUND_TOKEN
// Postmark sends Content-Type: application/json
'use strict';

const { Pool } = require('pg');
const { extractTokenFromAddress, processEmailIngest } = require('../../services/emailIngest');
const { handleEmailReceipt } = require('../../handlers/email/receipt');
const { handleEmailLead }    = require('../../handlers/email/lead');
const { sendWhatsApp }       = require('../../services/twilio');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const EMAIL_CAPTURE_DOMAIN = process.env.EMAIL_CAPTURE_DOMAIN || 'mail.usechiefos.com';
const DIGITS = (s) => String(s || '').replace(/\D/g, '');

// ─── Quota check ──────────────────────────────────────────────────────────────

async function getEmailCapCap(ownerId) {
  // Resolve plan from chiefos_tenants
  try {
    const { rows } = await pool.query(
      `SELECT plan FROM public.chiefos_tenants
       WHERE regexp_replace(coalesce(owner_id,''), '\\D', '', 'g') = $1
       LIMIT 1`,
      [DIGITS(ownerId)]
    );
    const plan = String(rows[0]?.plan || 'free').toLowerCase();
    if (plan === 'pro')     return null;     // unlimited
    if (plan === 'starter') return 30;
    return 0; // Free: disabled
  } catch {
    return 0;
  }
}

async function countThisMonthForTenant(tenantId) {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM public.email_ingest_events
     WHERE tenant_id = $1 AND created_at >= $2`,
    [tenantId, start.toISOString()]
  );
  return Number(rows[0]?.cnt || 0);
}

// ─── Tenant resolution ────────────────────────────────────────────────────────

async function resolveTenantFromToken(captureToken) {
  const { rows } = await pool.query(
    `SELECT id, owner_id FROM public.chiefos_tenants
     WHERE email_capture_token = $1 LIMIT 1`,
    [captureToken]
  );
  return rows[0] || null;
}

// ─── Dedup insert ─────────────────────────────────────────────────────────────

async function insertIngestEvent({ tenantId, ownerId, postmarkMsgId, fromEmail, subject, detectedKind, attachmentCount, sourceType }) {
  const { rows } = await pool.query(
    `INSERT INTO public.email_ingest_events
       (tenant_id, owner_id, postmark_msg_id, from_email, subject, detected_kind, attachment_count, source_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (postmark_msg_id) DO NOTHING
     RETURNING id`,
    [tenantId, ownerId, postmarkMsgId, fromEmail, subject, detectedKind, attachmentCount, sourceType]
  );
  return rows[0] || null; // null = duplicate
}

async function updateIngestStatus(postmarkMsgId, status) {
  await pool.query(
    `UPDATE public.email_ingest_events SET processing_status = $1 WHERE postmark_msg_id = $2`,
    [status, postmarkMsgId]
  );
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // 1. Allow only POST
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  // 2. Webhook secret verification
  const expectedToken = process.env.POSTMARK_INBOUND_TOKEN || '';
  const providedToken = String(req.query?.token || req.headers?.['x-inbound-token'] || '').trim();
  if (expectedToken && providedToken !== expectedToken) {
    console.warn('[inbound/email] unauthorized request — token mismatch');
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }

  const postmarkMsgId = String(payload.MessageID || '').trim();
  if (!postmarkMsgId) {
    return res.status(400).json({ ok: false, error: 'Missing MessageID' });
  }

  // 3. Extract capture token from To address
  const toAddress = String(
    payload.ToFull?.[0]?.Email || payload.To || ''
  ).toLowerCase().trim();

  const captureToken = extractTokenFromAddress(toAddress, EMAIL_CAPTURE_DOMAIN);
  if (!captureToken) {
    console.warn('[inbound/email] could not extract capture token from:', toAddress);
    return res.status(200).json({ ok: false, reason: 'no_capture_token' });
  }

  // 4. Resolve tenant
  let tenant;
  try {
    tenant = await resolveTenantFromToken(captureToken);
  } catch (e) {
    console.error('[inbound/email] tenant resolution error:', e?.message);
    return res.status(500).json({ ok: false, error: 'Tenant resolution failed' });
  }

  if (!tenant?.id || !tenant?.owner_id) {
    console.warn('[inbound/email] no tenant found for token:', captureToken);
    return res.status(200).json({ ok: false, reason: 'unknown_capture_token' });
  }

  const { id: tenantId, owner_id: ownerId } = tenant;
  const ownerDigits = DIGITS(ownerId);
  const fromEmail   = String(payload.FromFull?.Email || payload.From || '').trim();
  const subject     = String(payload.Subject || '').trim();
  const attachments = Array.isArray(payload.Attachments) ? payload.Attachments : [];

  // 5. Quota check
  const cap = await getEmailCapCap(ownerId);
  if (cap === 0) {
    console.info('[inbound/email] free plan — email capture blocked', { ownerId });
    await sendWhatsApp(`+${ownerDigits}`,
      '📧 Got a forwarded email, but email capture requires a Starter or Pro plan. Upgrade at usechiefos.com to unlock this.'
    ).catch(() => {});
    return res.status(200).json({ ok: false, reason: 'plan_not_included' });
  }

  if (cap !== null) {
    const used = await countThisMonthForTenant(tenantId);
    if (used >= cap) {
      console.info('[inbound/email] quota exceeded', { ownerId, used, cap });
      await sendWhatsApp(`+${ownerDigits}`,
        `📧 Email capture quota reached (${used}/${cap} this month). Upgrade to Pro for unlimited captures.`
      ).catch(() => {});
      // Still insert event so we don't re-notify on replay
      await insertIngestEvent({
        tenantId, ownerId, postmarkMsgId, fromEmail, subject,
        detectedKind: 'unknown', attachmentCount: attachments.length,
        sourceType: 'forwarded_receipt'
      }).catch(() => {});
      return res.status(200).json({ ok: false, reason: 'quota_exceeded' });
    }
  }

  // 6. Dedup — insert event record; skip if duplicate
  const event = await insertIngestEvent({
    tenantId, ownerId, postmarkMsgId, fromEmail, subject,
    detectedKind: 'pending', attachmentCount: attachments.length,
    sourceType: 'forwarded_receipt'
  }).catch(e => {
    console.error('[inbound/email] insertIngestEvent error:', e?.message);
    return null;
  });

  if (!event) {
    // ON CONFLICT DO NOTHING returned no row → already processed
    console.info('[inbound/email] duplicate email, skipping:', postmarkMsgId);
    return res.status(200).json({ ok: true, duplicate: true });
  }

  // 7. Process asynchronously — respond 200 immediately to Postmark (avoid timeout)
  res.status(200).json({ ok: true, event_id: event.id });

  // 8. Process in background
  setImmediate(async () => {
    try {
      const result = await processEmailIngest({ payload, tenantId, ownerId });

      await updateIngestStatus(postmarkMsgId, 'processing');

      if (result.kind === 'expense') {
        const { expense, mediaAssets } = result;
        await handleEmailReceipt({
          ownerId,
          tenantId,
          vendor:          expense.vendor,
          amountCents:     expense.amountCents,
          date:            expense.date,
          category:        expense.category,
          description:     expense.description,
          confidence:      expense.confidence,
          postmarkMsgId,
        });
        await updateIngestStatus(postmarkMsgId, 'processed');
        // Update kind in audit table
        await pool.query(
          `UPDATE public.email_ingest_events SET detected_kind = 'expense' WHERE postmark_msg_id = $1`,
          [postmarkMsgId]
        );

      } else if (result.kind === 'lead') {
        const { lead } = result;
        await handleEmailLead({
          ownerId,
          tenantId,
          name:         lead.name    || null,
          phone:        lead.phone   || null,
          email:        lead.email   || null,
          message:      lead.message || null,
          subject,
          postmarkMsgId,
        });
        await updateIngestStatus(postmarkMsgId, 'processed');
        await pool.query(
          `UPDATE public.email_ingest_events SET detected_kind = 'lead', source_type = 'lead_form' WHERE postmark_msg_id = $1`,
          [postmarkMsgId]
        );

      } else {
        // Unknown — let owner know
        await sendWhatsApp(`+${ownerDigits}`,
          `📧 Got a forwarded email I couldn't classify.\nSubject: "${subject || '(none)'}"\nCheck your portal Inbox if needed.`
        ).catch(() => {});
        await updateIngestStatus(postmarkMsgId, 'processed');
        await pool.query(
          `UPDATE public.email_ingest_events SET detected_kind = 'unknown' WHERE postmark_msg_id = $1`,
          [postmarkMsgId]
        );
      }

    } catch (e) {
      console.error('[inbound/email] background processing error:', e?.message, e?.stack);
      await updateIngestStatus(postmarkMsgId, 'failed').catch(() => {});
    }
  });
};
