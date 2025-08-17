require('dotenv').config();
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Plain message
async function sendMessage(to, body) {
  const dest = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  try {
    const message = await client.messages.create({
      body,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: dest,
    });
    console.log(`[✅ SUCCESS] Message sent: ${message.sid} channel=${message.channel || 'n/a'}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send message:', error.message, error.code, error.moreInfo);
    throw error;
  }
}

// Content Template (Quick Reply)
async function sendTemplateMessage(to, contentSid, contentVariables = []) {
  const dest = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  if (!contentSid) throw new Error('Missing ContentSid');

  // Normalize to {"1":"..","2":".."} as WhatsApp expects numbered placeholders
  const normalized = Array.isArray(contentVariables)
    ? contentVariables.reduce((acc, v, i) => {
        acc[String(i + 1)] = typeof v === 'string' ? v : (v?.text ?? String(v ?? ''));
        return acc;
      }, {})
    : contentVariables;

  try {
    const message = await client.messages.create({
      contentSid,
      contentVariables: JSON.stringify(normalized),
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: dest,
    });
    console.log(`[✅ SUCCESS] Template sent: ${message.sid} contentSid=${contentSid}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send template:', error.message, error.code, error.moreInfo);
    throw error;
  }
}

module.exports = { sendMessage, sendTemplateMessage };
