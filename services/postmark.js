// services/postmark.js
// Outbound email via Postmark. Requires POSTMARK_SERVER_TOKEN env var.
// POSTMARK_FROM_EMAIL should be a verified sender address in your Postmark account.

const postmark = require("postmark");

const SERVER_TOKEN = String(process.env.POSTMARK_SERVER_TOKEN || "").trim();
const FROM_EMAIL = String(process.env.POSTMARK_FROM_EMAIL || "").trim();

function getClient() {
  if (!SERVER_TOKEN) throw new Error("POSTMARK_SERVER_TOKEN is not configured.");
  return new postmark.ServerClient(SERVER_TOKEN);
}

/**
 * Send a plain-text + HTML email via Postmark.
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.textBody
 * @param {string} [opts.htmlBody]
 * @param {string} [opts.from]   defaults to POSTMARK_FROM_EMAIL
 */
async function sendEmail({ to, subject, textBody, htmlBody, from }) {
  const client = getClient();
  const fromAddr = from || FROM_EMAIL;
  if (!fromAddr) throw new Error("POSTMARK_FROM_EMAIL is not configured.");

  const result = await client.sendEmail({
    From: fromAddr,
    To: to,
    Subject: subject,
    TextBody: textBody,
    HtmlBody: htmlBody || undefined,
    MessageStream: "outbound",
  });

  console.info("[POSTMARK] sendEmail result", { MessageID: result.MessageID, To: to });
  return result;
}

module.exports = { sendEmail };
