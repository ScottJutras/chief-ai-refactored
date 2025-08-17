require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendMessage(to, body) {
  try {
    const message = await client.messages.create({
      body,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID
    });
    console.log(`[✅ SUCCESS] Message sent: ${message.sid}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send message:', error.message);
    throw error;
  }
}

async function sendQuickReply(to, body, replies = []) {
  try {
    const message = await client.messages.create({
      body,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      persistentAction: replies.map(reply => `reply?text=${encodeURIComponent(reply)}`)
    });
    console.log(`[✅ SUCCESS] Quick reply sent: ${message.sid}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send quick reply:', error.message);
    throw error;
  }
}

async function sendTemplateMessage(to, contentSid, contentVariables = {}) {
  try {
    if (!contentSid) {
      console.error('[ERROR] Missing ContentSid for Twilio template message.');
      throw new Error('Missing ContentSid');
    }
    const formattedVariables = JSON.stringify(
      Array.isArray(contentVariables)
        ? contentVariables.reduce((acc, item, index) => {
            acc[index + 1] = item.text;
            return acc;
          }, {})
        : contentVariables
    );
    const message = await client.messages.create({
      contentSid,
      contentVariables: formattedVariables,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID
    });
    console.log(`[✅ SUCCESS] Template message sent: ${message.sid}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send template message:', error.message);
    throw error;
  }
}

module.exports = { sendMessage, sendQuickReply, sendTemplateMessage };