const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendMessage(to, body) {
  console.log('[DEBUG] sendMessage called:', { to, body });
  try {
    const message = await client.messages.create({
      body,
      from: 'whatsapp:+12316802664',
      to: `whatsapp:${to}`
    });
    console.log('[DEBUG] sendMessage success:', message.sid);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] sendMessage failed for', to, ':', error.message);
    throw error;
  }
}

async function sendQuickReply(to, body, replies = []) {
  console.log('[DEBUG] sendQuickReply called:', { to, body, replies });
  try {
    const message = await client.messages.create({
      body,
      from: 'whatsapp:+12316802664',
      to: `whatsapp:${to}`,
      persistentAction: replies.map(reply => `reply?text=${encodeURIComponent(reply)}`)
    });
    console.log('[DEBUG] sendQuickReply success:', message.sid);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] sendQuickReply failed for', to, ':', error.message);
    throw error;
  }
}

async function sendTemplateMessage(to, template, params = []) {
  console.log('[DEBUG] sendTemplateMessage called:', { to, template, params });
  try {
    const message = template.replace(/{(\d+)}/g, (_, index) => params[index]?.text || '');
    await client.messages.create({
      body: message,
      from: 'whatsapp:+12316802664',
      to: `whatsapp:${to}`
    });
    console.log('[DEBUG] sendTemplateMessage success for', to);
  } catch (error) {
    console.error('[ERROR] sendTemplateMessage failed for', to, ':', error.message);
    throw error;
  }
}

module.exports = { sendMessage, sendQuickReply, sendTemplateMessage };