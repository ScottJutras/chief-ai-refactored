// handlers/commands/quote.js
// MVP: Quote -> PDF buffer -> Supabase Storage -> signed link -> WhatsApp response
// No Postmark required.

const crypto = require('crypto');
const pg = require('../../services/postgres');

const { parseQuoteMessage, buildQuoteDetails } = require('../../utils/quoteUtils');
const { generateQuotePDFBuffer } = require('../../utils/pdfService');
const { uploadQuotePdfBuffer, createQuoteSignedUrl } = require('../../utils/storageQuotes');
const { PRO_CREW_UPGRADE_LINE, UPGRADE_FOLLOWUP_ASK } = require('../../src/config/upgradeCopy');

function isQuoteCommand(text) {
  const s = String(text || '').trim().toLowerCase();
  return /^quote\s+for\b/.test(s);
}

function newQuoteId() {
  // short, URL-safe-ish id for paths/logs
  // ex: q_2f9c1f8a1b2c
  return `q_${crypto.randomBytes(6).toString('hex')}`;
}

async function handleQuoteCommand({ ownerId, from, text, userProfile }) {
  const owner_id = String(ownerId || '').replace(/\D/g, '');
  const actor_id = String(from || '').replace(/\D/g, '');

  if (!owner_id) return false;

  if (!isQuoteCommand(text)) return false;

  const parsed = parseQuoteMessage(text);
  if (!parsed) {
    return `Try: quote for <job>: 2 paint, 10 shingles, $50 for disposal plus 40%`;
  }

  // price + totals
  const details = await buildQuoteDetails(parsed, owner_id);

  if (details.missingItems?.length) {
    return (
      `I can’t price: ${details.missingItems.join(', ')}.\n` +
      `Add them to pricing first, or give a manual price like "$50 for ${details.missingItems[0]}".`
    );
  }

  // MVP: tax/subtotal handling
  // If you already have locale tax logic elsewhere, swap this.
  const subtotal = Number(details.total || 0);
  const tax = 0;
  const total = subtotal + tax;

  const quoteId = newQuoteId();

  // Build PDF data model
  const quoteData = {
    jobName: parsed.jobName,
    items: details.items,
    subtotal,
    tax,
    total,
    customerName: null, // MVP: you can ask later or infer from message
    contractorName: userProfile?.name || 'Contractor',
    companyName: userProfile?.business_name || userProfile?.company_name || null,
    companyAddress: userProfile?.company_address || null,
    companyPhone: userProfile?.phone || null,
    logoUrl: userProfile?.logo_url || null
  };

  // Generate PDF buffer
  const pdfBuffer = await generateQuotePDFBuffer(quoteData);

  // Upload (immutable path: quote_v1.pdf)
  const { bucket, path } = await uploadQuotePdfBuffer({
    ownerId: owner_id,
    quoteId,
    buffer: pdfBuffer,
    bucket: 'quotes'
  });

  // Signed URL for customer
  const signedUrl = await createQuoteSignedUrl({
    bucket,
    path,
    expiresInSec: 60 * 60 * 24 * 7 // 7 days
  });

  // Optional: persist record if you have a quotes table/function
  // Fail-open for MVP.
  try {
    if (typeof pg.createQuoteRecord === 'function') {
      await pg.createQuoteRecord({
        ownerId: owner_id,
        quoteId,
        jobName: parsed.jobName,
        total,
        pdfPath: path,
        createdBy: actor_id,
        source: 'whatsapp'
      });
    }
  } catch {}

  return (
    `✅ Quote ready for ${parsed.jobName}\n` +
    `Total: $${total.toFixed(2)}\n` +
    `Link (7 days): ${signedUrl}\n\n` +
    `Tip: reply "quote status ${quoteId}" (coming in Beta).`
  );
}

module.exports = { handleQuoteCommand, isQuoteCommand };
