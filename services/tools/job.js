// services/tools/job.js
const handleJob = require('../../handlers/commands/job');

/**
 * Call the existing job handler with a fake Express res so we can capture its TwiML/text.
 * Adjust the arg order if your handleJob signature differs.
 */
async function runJobHandler({ fromPhone, ownerId, text }) {
  // Minimal stand-ins — the handler ignores most of these for simple routes
  const userProfile = null;
  const ownerProfile = null;
  const isOwner = true;

  // Fake res to capture output
  let captured = null;
  const res = {
    headersSent: false,
    status(code) { return this; },
    type(t) { return this; },
    send(body) { this.headersSent = true; captured = body; return this; }
  };

  // Call your real handler (same as other routers do)
  const out = await handleJob(fromPhone, text, userProfile, ownerId, ownerProfile, isOwner, res);

  // Normalize possible return shapes
  if (typeof out === 'string') return out;                           // TwiML string
  if (out && typeof out === 'object' && typeof out.twiml === 'string') return out.twiml;
  if (captured) return captured;                                     // anything the handler sent
  return '';                                                         // nothing explicit
}

const jobTool = {
  type: 'function',
  function: {
    name: 'jobs_action',
    description: 'Create/set/list jobs, move last log to a job, ask "active job?", etc.',
    parameters: {
      type: 'object',
      properties: {
        text:      { type: 'string', description: 'Original user text, e.g., "create job Oak St"' },
        ownerId:   { type: 'string' },
        fromPhone: { type: 'string' }
      },
      required: ['text', 'ownerId', 'fromPhone']
    }
  },
  __handler: async (args) => {
    const twimlOrText = await runJobHandler({
      fromPhone: args.fromPhone,
      ownerId:   args.ownerId,
      text:      args.text
    });
    // Return a simple JSON payload for the agent loop
    return { message: twimlOrText };
  }
};

module.exports = { jobTool };
