// handlers/email/receipt.js
// Handles the flow for an email receipt: creates pending_action → sends WhatsApp confirmation.
// The owner replies in WhatsApp; the expense is logged via the existing confirm_expense flow.
'use strict';

const pg = require('../../services/postgres');
const { sendQuickReply } = require('../../services/twilio');

const PA_KIND_CONFIRM = 'confirm_expense';
const DIGITS = (s) => String(s || '').replace(/\D/g, '');

/**
 * Creates a pending_action for email receipt confirmation and sends WhatsApp to owner.
 *
 * @param {object} opts
 * @param {string}      opts.ownerId       - Owner phone digits
 * @param {string}      opts.tenantId      - UUID
 * @param {string}      opts.vendor
 * @param {number|null} opts.amountCents
 * @param {string}      opts.date          - YYYY-MM-DD
 * @param {string|null} opts.category
 * @param {string}      opts.description
 * @param {number}      opts.confidence    - 0–1
 * @param {string}      opts.postmarkMsgId - Idempotency key
 */
async function handleEmailReceipt(opts) {
  const { ownerId, tenantId, vendor, amountCents, date, category, description,
          confidence, postmarkMsgId } = opts;

  const ownerDigits = DIGITS(ownerId);
  if (!ownerDigits) {
    console.warn('[emailReceipt] no owner digits — cannot send WhatsApp');
    return;
  }

  const toPhone = `+${ownerDigits}`;

  // Build the draft that the existing confirm_expense flow expects
  const draft = {
    store:           vendor || 'Unknown',
    item:            description || 'Receipt',
    amount:          amountCents != null ? amountCents / 100 : null,
    amount_cents:    amountCents,
    date:            date || new Date().toISOString().slice(0, 10),
    category:        category || null,
    sourceMsgId:     `email:${postmarkMsgId}`,
    source:          'email',
    originalText:    description || `Email receipt from ${vendor}`,
    draftText:       description || `Email receipt from ${vendor}`,
  };

  // Store pending action using the same kind as WhatsApp expense confirms
  // so the existing webhook routing handles the reply automatically
  await pg.upsertPendingAction({
    ownerId:    ownerDigits,
    userId:     ownerDigits,
    kind:       PA_KIND_CONFIRM,
    payload: {
      draft,
      sourceMsgId: draft.sourceMsgId,
      type: 'expense',
    },
    ttlSeconds: 3600, // 1 hour (email has longer TTL than WhatsApp)
  });

  // Build WhatsApp message
  let msgLines = ['📧 *Email receipt captured*'];

  if (vendor && vendor !== 'Unknown') msgLines.push(`*${vendor}*`);

  if (amountCents != null) {
    msgLines.push(`$${(amountCents / 100).toFixed(2)}`);
  } else {
    msgLines.push('Amount not detected — I\'ll need your help');
  }

  if (date) msgLines.push(`Date: ${date}`);
  if (category) msgLines.push(`Category: ${category}`);

  msgLines.push('');
  msgLines.push('Which job should I attach this to? Reply with the job name or number, or say "no job".');

  if (confidence < 0.5) {
    msgLines.push('');
    msgLines.push('_(Some details may be incomplete — confirm or correct when logging.)_');
  }

  const body = msgLines.join('\n');

  try {
    await sendQuickReply(toPhone, body, ['No job', 'Cancel']);
    console.info('[emailReceipt] WhatsApp sent', { ownerId: ownerDigits, vendor, amountCents });
  } catch (e) {
    console.error('[emailReceipt] WhatsApp send failed:', e?.message);
  }
}

module.exports = { handleEmailReceipt };
