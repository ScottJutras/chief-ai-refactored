// services/tools/tasks.js
const { tasksHandler } = require('../../handlers/commands/tasks');
const tool = {
  type: 'function',
  function: {
    name: 'tasks_action',
    description: 'Create/list/assign/set due dates using the existing parser.',
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
    const resp = await tasksHandler({ text, ownerId, fromPhone });
    return { message: resp };
  }
};
module.exports = { tasksTool: tool };