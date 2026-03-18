// services/tools/timeclock.js
const { handleTimeclock } = require('../../handlers/commands/timeclock');

// Build a minimal fake res object that captures twiml(res, body) output.
// handleTimeclock calls res.status(200).type(...).send(xmlString) and returns true.
function makeFakeRes() {
  const captured = { body: null };
  const res = {
    _captured: captured,
    status() { return this; },
    type()   { return this; },
    send(xmlStr) {
      // Extract message text from <Message>...</Message>
      const m = String(xmlStr || '').match(/<Message>([\s\S]*?)<\/Message>/i);
      captured.body = m
        ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        : String(xmlStr || '');
      return this;
    },
    req: { body: {} }
  };
  return res;
}

const tool = {
  type: 'function',
  function: {
    name: 'timeclock_action',
    description: 'Clock in/out/break/drive or report hours using the existing parser.',
    parameters: {
      type: 'object',
      properties: {
        text:      { type: 'string' },
        ownerId:   { type: 'string' },
        fromPhone: { type: 'string' }
      },
      required: ['text', 'ownerId', 'fromPhone']
    }
  },
  __handler: async ({ text, ownerId, fromPhone }) => {
    const res = makeFakeRes();
    // handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId)
    await handleTimeclock(fromPhone, text, null, ownerId, null, true, res, null);
    return { message: res._captured.body || 'Time logged.' };
  }
};

module.exports = { timeclockTool: tool };
