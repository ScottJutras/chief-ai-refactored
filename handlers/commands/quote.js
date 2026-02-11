// handlers/commands/quote.js
// MVP: Quote -> PDF buffer -> Supabase Storage -> signed link -> WhatsApp response
// No Postmark required.

const crypto = require('crypto');
const pg = require('../../services/postgres');

const { parseQuoteMessage, buildQuoteDetails } = require('../../utils/quoteUtils');
const { generateQuotePDFBuffer } = require('../../utils/pdfService');
const { uploadQuotePdfBuffer, createQuoteSignedUrl } = require('../../utils/storageQuotes');

const { checkMonthlyQuota, consumeMonthlyQuota } = require('../../utils/quota');

function isQuoteCommand(text) {
  const s = String(text || '').trim().toLowerCase();
  return /^quote\s+for\b/.test(s);
}

function newQuoteId() {
  // short, URL-safe-ish id for paths/logs
  return `q_${crypto.randomBytes(6).toString('hex')}`;
}

function resolvePlanKey(userProfile) {
  return (
    String(userProfile?.plan_key || userProfile?.paid_tier || userProfile?.subscription_tier || 'free')
      .toLowerCase()
      .trim() || 'free'
  );
}

async function handleQuoteCommand({ ownerId, from, text, userProfile }) {
  const owner_id = String(ownerId || '').trim(); // ✅ keep UUID intact
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
  const subtotal = Number(details.total || 0);
  const tax = 0;
  const total = subtotal + tax;

  const quoteId = newQuoteId();

  const quoteData = {
    jobName: parsed.jobName,
    items: details.items,
    subtotal,
    tax,
    total,
    customerName: null,
    contractorName: userProfile?.name || 'Contractor',
    companyName: userProfile?.business_name || userProfile?.company_name || null,
    companyAddress: userProfile?.company_address || null,
    companyPhone: userProfile?.phone || null,
    logoUrl: userProfile?.logo_url || null
  };

  const planKey = resolvePlanKey(userProfile);

  // ✅ Gate + consume BEFORE PDF generation (server cost surface)
  try {
    const q = await checkMonthlyQuota({ ownerId: owner_id, planKey, kind: 'export_pdf', units: 1 });
    if (!q.ok) {
      return `You’ve hit your monthly PDF limit.\n\nUpgrade to Pro for more exports.`;
    }
    await consumeMonthlyQuota({ ownerId: owner_id, kind: 'export_pdf', units: 1 });
  } catch (e) {
    return `PDF export is temporarily unavailable. Please try again.`;
  }

  // Generate PDF buffer
  const pdfBuffer = await generateQuotePDFBuffer(quoteData);

  // Upload
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
    expiresInSec: 60 * 60 * 24 * 7
  });

  // Optional: persist record (fail-open)
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
