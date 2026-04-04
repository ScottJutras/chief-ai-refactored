// services/emailIngest.js
// Parses Postmark inbound email payloads, extracts structured expense/lead data,
// and routes to the appropriate handler.
'use strict';

const { callOpenAI, getOpenAIClient } = require('./openAI');
const { createClient } = require('@supabase/supabase-js');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

function coerceJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf('{');
  const end   = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch {}
  }
  return null;
}

function parseAmountFromText(text) {
  if (!text) return null;
  // Patterns: "Total: $247.52", "Amount Due: 247.52", "Order Total $1,247.00"
  const patterns = [
    /(?:total|total due|amount due|order total|grand total|you paid)[:\s]+\$?([\d,]+\.\d{2})/i,
    /\$\s*([\d,]+\.\d{2})/,
    /([\d,]+\.\d{2})\s*(?:CAD|USD)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (isFinite(n) && n > 0) return Math.round(n * 100);
    }
  }
  return null;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function emailDateToIso(dateStr) {
  if (!dateStr) return todayIso();
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  } catch {}
  return todayIso();
}

function extractTokenFromAddress(toAddress, domain) {
  // e.g. "capture-abc123def@mail.usechiefos.com" → "abc123def"
  // or "abc123def@mail.usechiefos.com" → "abc123def"
  if (!toAddress) return null;
  const d = String(domain || process.env.EMAIL_CAPTURE_DOMAIN || 'mail.usechiefos.com').toLowerCase();
  const lower = toAddress.toLowerCase();
  if (!lower.includes(d)) return null;
  const local = lower.split('@')[0];
  // strip leading "capture-" prefix if present
  return local.replace(/^capture-/, '').trim() || null;
}

// ─── Kind detection ───────────────────────────────────────────────────────────

const LEAD_SUBJECT_PATTERNS  = /inquiry|contact us|quote request|new lead|website submission|new message|contact form/i;
const LEAD_SENDER_PATTERNS   = /noreply|no-reply|donotreply|do-not-reply|form@|webmaster|website@|info@|contact@|admin@/i;
const EXPENSE_SUBJECT_PATTERNS = /receipt|order|invoice|purchase|payment|confirmation|your order|transaction|billing/i;

function detectEmailKind(fromEmail, subject, textBody) {
  const from    = String(fromEmail || '').toLowerCase();
  const subj    = String(subject   || '').toLowerCase();
  const body    = String(textBody  || '').toLowerCase();

  if (LEAD_SUBJECT_PATTERNS.test(subj) || LEAD_SENDER_PATTERNS.test(from)) {
    // Check if body has contact info patterns
    if (/name:|phone:|email:|message:|inquiry/i.test(textBody)) return 'lead';
  }

  if (EXPENSE_SUBJECT_PATTERNS.test(subj)) return 'expense';

  // Body-level expense signals
  if (/total[:\s]+\$[\d,]+/i.test(body) || /amount[:\s]+\$[\d,]+/i.test(body)) return 'expense';

  // Lead body signals
  if (LEAD_SUBJECT_PATTERNS.test(body)) return 'lead';

  return 'unknown';
}

// ─── Attachment handling ──────────────────────────────────────────────────────

async function storeAttachment({ tenantId, ownerId, msgId, idx, contentType, base64Content }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.warn('[emailIngest] Supabase admin not available — skipping attachment upload');
    return null;
  }

  const ext = (contentType.split('/')[1] || 'bin').replace(/jpeg/, 'jpg');
  const path = `email-attachments/${tenantId}/${msgId.replace(/[^a-z0-9]/gi, '_')}_${idx}.${ext}`;
  const buffer = Buffer.from(base64Content, 'base64');

  const { error } = await supabase.storage
    .from('intake-uploads')
    .upload(path, buffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    console.error('[emailIngest] attachment upload error:', error.message);
    return null;
  }

  // Get a long-lived signed URL (7 days)
  const { data: signed } = await supabase.storage
    .from('intake-uploads')
    .createSignedUrl(path, 60 * 60 * 24 * 7);

  return {
    storageProvider: 'supabase',
    storagePath: path,
    signedUrl: signed?.signedUrl ?? null,
    contentType,
    sizeBytes: buffer.byteLength,
  };
}

// ─── OCR via GPT-4o vision ───────────────────────────────────────────────────

async function ocrAttachmentWithVision(base64Content, contentType) {
  try {
    const openai = getOpenAIClient();
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 400,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${contentType};base64,${base64Content}` }
          },
          {
            type: 'text',
            text: `Extract receipt data from this image. Return JSON only, no markdown:
{
  "vendor": "store name or null",
  "amount": total amount as a number or null,
  "date": "YYYY-MM-DD or null",
  "tax": tax amount as a number or null,
  "description": "brief description or null"
}`
          }
        ]
      }]
    });

    const raw = response.choices[0]?.message?.content || '';
    return coerceJson(raw);
  } catch (e) {
    console.warn('[emailIngest] vision OCR failed:', e?.message);
    return null;
  }
}

// ─── PDF text extraction ──────────────────────────────────────────────────────

async function extractTextFromPdf(base64Content) {
  try {
    const buf = Buffer.from(base64Content, 'base64');
    const data = await pdfParse(buf);
    return String(data.text || '').trim();
  } catch (e) {
    console.warn('[emailIngest] pdf-parse failed:', e?.message);
    return '';
  }
}

// ─── Main expense extraction ──────────────────────────────────────────────────

async function extractExpenseFromEmail({ from, subject, textBody, htmlBody, attachments, dateStr }) {
  // 1. Try regex extraction from text body first (fast, no LLM cost)
  const amountFromRegex = parseAmountFromText(textBody) || parseAmountFromText(htmlBody?.replace(/<[^>]+>/g, ' '));
  const dateFromEmail   = emailDateToIso(dateStr);

  // Attempt to determine vendor from subject line
  let vendorFromSubject = null;
  const subjectVendorMatch = String(subject || '').match(/(?:receipt|order|invoice)\s+from\s+(.+?)(?:\s+-|\s*$)/i);
  if (subjectVendorMatch) vendorFromSubject = subjectVendorMatch[1].trim();

  // 2. Try OCR on the first supported attachment
  let ocrResult = null;
  for (const att of (attachments || [])) {
    const ct = String(att.ContentType || '').toLowerCase();
    if (ct.startsWith('image/') && att.Content) {
      ocrResult = await ocrAttachmentWithVision(att.Content, ct);
      break;
    }
    if (ct === 'application/pdf' && att.Content) {
      const pdfText = await extractTextFromPdf(att.Content);
      if (pdfText) {
        // Extract amount from PDF text
        const pdfAmount = parseAmountFromText(pdfText);
        if (pdfAmount) {
          ocrResult = { amount: pdfAmount / 100, vendor: vendorFromSubject, date: dateFromEmail };
        }
        // Use LLM to extract from PDF text
        if (!ocrResult?.vendor) {
          const llmRaw = await callOpenAI(
            `Extract expense data from this receipt text. Return JSON only, no markdown: { "vendor": string|null, "amount": number|null, "date": "YYYY-MM-DD"|null, "description": string|null }`,
            pdfText.slice(0, 2000),
            'gpt-4o',
            200,
            0
          );
          ocrResult = coerceJson(llmRaw);
        }
      }
      break;
    }
  }

  // 3. If regex + OCR not enough, use LLM on email text body
  let llmResult = null;
  if (!amountFromRegex && !ocrResult?.amount) {
    const inputText = [
      `Subject: ${subject || ''}`,
      `From: ${from || ''}`,
      `Body: ${String(textBody || '').slice(0, 1500)}`
    ].join('\n');

    try {
      const raw = await callOpenAI(
        `Extract expense data from this forwarded receipt email. Return JSON only, no markdown:
{ "vendor": "store name or null", "amount": total amount as a number or null, "date": "YYYY-MM-DD or null", "category": "expense category or null", "description": "brief description or null" }`,
        inputText,
        'gpt-4o',
        200,
        0
      );
      llmResult = coerceJson(raw);
    } catch (e) {
      console.warn('[emailIngest] LLM expense extraction failed:', e?.message);
    }
  }

  // 4. Merge all sources, preferring OCR > regex > LLM
  const vendor = String(
    ocrResult?.vendor || vendorFromSubject || llmResult?.vendor ||
    (from ? from.split('@')[0].replace(/[._-]/g, ' ') : '') || 'Unknown'
  ).trim().slice(0, 100);

  const amountCents =
    (ocrResult?.amount ? Math.round(Number(ocrResult.amount) * 100) : null) ||
    amountFromRegex ||
    (llmResult?.amount ? Math.round(Number(llmResult.amount) * 100) : null) ||
    null;

  const date = ocrResult?.date || llmResult?.date || dateFromEmail;

  const category  = llmResult?.category || null;
  const description = String(ocrResult?.description || llmResult?.description || subject || 'Email receipt').trim().slice(0, 200);

  const confidence = amountCents ? (ocrResult?.amount ? 0.9 : 0.7) : 0.3;

  return { vendor, amountCents, date, category, description, confidence };
}

// ─── Lead extraction ──────────────────────────────────────────────────────────

async function extractLeadFromEmail({ from, subject, textBody }) {
  const inputText = [
    `Subject: ${subject || ''}`,
    `From: ${from || ''}`,
    `Body: ${String(textBody || '').slice(0, 1500)}`
  ].join('\n');

  try {
    const raw = await callOpenAI(
      `Extract contact information from this website inquiry/lead email. Return JSON only, no markdown:
{ "name": "full name or null", "phone": "phone number or null", "email": "email address or null", "message": "their inquiry message or null" }`,
      inputText,
      'gpt-4o',
      200,
      0
    );
    return coerceJson(raw) || {};
  } catch (e) {
    console.warn('[emailIngest] LLM lead extraction failed:', e?.message);
    return {};
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function processEmailIngest({ payload, tenantId, ownerId }) {
  const from     = String(payload.FromFull?.Email || payload.From || '').trim();
  const subject  = String(payload.Subject || '').trim();
  const textBody = String(payload.TextBody || '').trim();
  const htmlBody = String(payload.HtmlBody || '').trim();
  const dateStr  = String(payload.Date || '').trim();
  const attachments = Array.isArray(payload.Attachments) ? payload.Attachments : [];
  const msgId    = String(payload.MessageID || '').trim();

  const kind = detectEmailKind(from, subject, textBody);

  // Store any image/PDF attachments
  const mediaAssets = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const ct = String(att.ContentType || '').toLowerCase();
    if ((ct.startsWith('image/') || ct === 'application/pdf') && att.Content) {
      const asset = await storeAttachment({
        tenantId, ownerId,
        msgId,
        idx: i,
        contentType: ct,
        base64Content: att.Content,
      });
      if (asset) mediaAssets.push(asset);
    }
  }

  if (kind === 'expense') {
    const expense = await extractExpenseFromEmail({ from, subject, textBody, htmlBody, attachments, dateStr });
    return { kind: 'expense', expense, mediaAssets };
  }

  if (kind === 'lead') {
    const lead = await extractLeadFromEmail({ from, subject, textBody });
    return { kind: 'lead', lead };
  }

  return { kind: 'unknown', subject };
}

module.exports = {
  extractTokenFromAddress,
  detectEmailKind,
  processEmailIngest,
};
