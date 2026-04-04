// handlers/email/lead.js
// Handles the flow for an email lead (contact form submission):
// creates pending_action → sends WhatsApp → on "Yes" creates a job in lead stage.
'use strict';

const pg = require('../../services/postgres');
const { sendQuickReply, sendWhatsApp } = require('../../services/twilio');

const PA_KIND_EMAIL_LEAD = 'confirm_email_lead';
const DIGITS = (s) => String(s || '').replace(/\D/g, '');

/**
 * Sends WhatsApp notification about a new email lead and creates a pending_action.
 */
async function handleEmailLead(opts) {
  const { ownerId, tenantId, name, phone, email, message, subject, postmarkMsgId } = opts;

  const ownerDigits = DIGITS(ownerId);
  if (!ownerDigits) {
    console.warn('[emailLead] no owner digits — cannot send WhatsApp');
    return;
  }

  const toPhone = `+${ownerDigits}`;

  // Store pending action
  await pg.upsertPendingAction({
    ownerId:    ownerDigits,
    userId:     ownerDigits,
    kind:       PA_KIND_EMAIL_LEAD,
    payload: {
      name:    name    || null,
      phone:   phone   || null,
      email:   email   || null,
      message: message || null,
      subject: subject || null,
      sourceMsgId: `email:${postmarkMsgId}`,
    },
    ttlSeconds: 86400, // 24 hours for lead (owner might not be near phone)
  });

  // Build WhatsApp message
  const lines = ['📧 *New lead from your website*', ''];
  if (name)    lines.push(`*${name}*`);
  if (phone)   lines.push(`📞 ${phone}`);
  if (email)   lines.push(`✉️ ${email}`);
  if (message) lines.push(`"${message.trim().slice(0, 200)}"`);

  lines.push('');
  lines.push('Reply "Yes" to create a job, or "No" to dismiss.');

  const body = lines.join('\n');

  try {
    await sendQuickReply(toPhone, body, ['Yes', 'No']);
    console.info('[emailLead] WhatsApp sent', { ownerId: ownerDigits, name, phone });
  } catch (e) {
    console.error('[emailLead] WhatsApp send failed:', e?.message);
  }
}

/**
 * Handles the owner's "Yes" or "No" reply to a lead confirmation.
 * Called from routes/webhook.js when PA kind = 'confirm_email_lead'.
 *
 * @param {object} req - Express request (with req.from, req.ownerId, req.body)
 * @param {object} res - Express response
 */
async function handleEmailLeadConfirm(req, res) {
  const { from, ownerId } = req;
  const ownerDigits = DIGITS(ownerId || from);
  const toPhone     = `+${ownerDigits}`;
  const body        = String(req.body?.Body || req.body?.ButtonPayload || '').trim().toLowerCase();

  // Load the pending action
  const pa = await pg.getPendingActionByKind({
    ownerId: ownerDigits,
    userId:  ownerDigits,
    kind:    PA_KIND_EMAIL_LEAD,
  }).catch(() => null);

  // Always clean up
  await pg.deletePendingActionByKind({
    ownerId: ownerDigits,
    userId:  ownerDigits,
    kind:    PA_KIND_EMAIL_LEAD,
  }).catch(() => {});

  if (!pa?.payload) {
    await sendWhatsApp(toPhone, 'That lead is no longer pending. Nothing was created.');
    return;
  }

  const { name, phone, message, email, subject } = pa.payload;
  const isYes = /^(yes|y|create|ok)\b/i.test(body);

  if (!isYes) {
    await sendWhatsApp(toPhone, 'Lead dismissed. Nothing was created.');
    return;
  }

  // Create the job in lead stage
  try {
    const jobName = name
      ? `${name} — ${(message || subject || 'Inquiry').slice(0, 40)}`
      : (message || subject || 'Website lead').slice(0, 60);

    // Use existing job creation logic from postgres
    const { rows } = await pg._query(`
      INSERT INTO public.jobs (owner_id, job_name, status, created_at, updated_at)
      VALUES ($1, $2, 'active', NOW(), NOW())
      RETURNING id, job_no
    `, [ownerDigits, jobName]).catch(() => ({ rows: [] }));

    const jobRow = rows[0];

    // Also create a customer record if we have contact info
    if (jobRow?.id && (name || phone || email)) {
      await pg._query(`
        INSERT INTO public.customers (tenant_id, owner_id, name, phone, email, created_at)
        VALUES (
          (SELECT id FROM public.chiefos_tenants WHERE regexp_replace(coalesce(owner_id,''), '\\D','','g') = $1 LIMIT 1),
          $1, $2, $3, $4, NOW()
        )
        ON CONFLICT DO NOTHING
      `, [ownerDigits, name || null, phone || null, email || null]).catch(() => {});
    }

    if (jobRow?.job_no) {
      await sendWhatsApp(toPhone,
        `✅ Job #${jobRow.job_no} created: "${jobName}".\nLog costs with "expense $X vendor" or revenue with "revenue $X".`
      );
    } else {
      await sendWhatsApp(toPhone, `✅ Job created: "${jobName}".`);
    }

    console.info('[emailLead] job created from lead', { ownerId: ownerDigits, name, jobNo: jobRow?.job_no });
  } catch (e) {
    console.error('[emailLead] job creation failed:', e?.message);
    await sendWhatsApp(toPhone, `Could not create the job: ${e?.message}. Try creating it manually.`);
  }
}

module.exports = { handleEmailLead, handleEmailLeadConfirm };
