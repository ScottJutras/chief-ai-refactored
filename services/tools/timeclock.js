// services/tools/timeclock.js
const { handleTimeclock } = require('../../handlers/commands/timeclock');
const tool = {
  type: 'function',
  function: {
    name: 'timeclock_action',
    description: 'Clock in/out/break/drive or report hours using the existing parser.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        ownerId: { type: 'string' },
        fromPhone: { type: 'string' }
      },
      required: ['text','ownerId','fromPhone']
    }
  },
  __handler: async ({ text, ownerId, fromPhone }) => {
    const resp = await handleTimeclock({ text, ownerId, fromPhone });
    return { message: resp };
  }
};
module.exports = { timeclockTool: tool };