require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Plain text / media message
 */
async function sendMessage(to, body) {
  try {
    const message = await client.messages.create({
      body,
      // Use EITHER messagingServiceSid OR from. Prefer the service for WhatsApp senders.
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
    });
    console.log(`[✅ SUCCESS] Message sent: ${message.sid}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send message:', error?.message, error?.code, error?.moreInfo);
    throw error;
  }
}

/**
 * WhatsApp buttons must be sent via an approved Content Template (twilio/quick-reply).
 * Pass the HX Content SID and numbered variables matching {{1}}, {{2}}, etc.
 */
async function sendTemplateMessage(to, contentSid, contentVariables = {}) {
  try {
    if (!contentSid) {
      throw new Error('Missing ContentSid');
    }

    // Normalize variables: accept array => { "1": "...", "2": "..." }
    const normalized =
      Array.isArray(contentVariables)
        ? contentVariables.reduce((acc, val, i) => {
            acc[(i + 1).toString()] = typeof val === 'string' ? val : val?.text ?? '';
            return acc;
          }, {})
        : contentVariables;

    const message = await client.messages.create({
      contentSid,
      contentVariables: JSON.stringify(normalized),
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
    });

    console.log(`[✅ SUCCESS] Template message sent: ${message.sid}`);
    return message.sid;
  } catch (error) {
    // Common causes of “plain text fallback”:
    // - Template not approved / wrong type (not twilio/quick-reply)
    // - Using Sandbox sender
    // - Variables don’t match placeholders
    console.error('[ERROR] Failed to send template message:', error?.message, error?.code, error?.moreInfo);
    throw error;
  }
}

module.exports = { sendMessage, sendTemplateMessage };
