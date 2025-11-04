// services/agent.js
const PROVIDER = (process.env.AI_PROVIDER || 'openai').toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const DEFAULT_TOOLS = [
  {
    name: 'get_job_kpis',
    description: 'Get KPIs for a job.',
    parameters: {
      type: 'object',
      properties: { job: { type: 'string' }, window: { type: 'string', enum: ['MTD','YTD','ALL'] } },
      required: ['job'],
    },
  },
];

function canUseAgent(userProfile) {
  const tier = (userProfile?.subscription_tier || 'basic').toLowerCase();
  return tier !== 'basic';
}

async function _askOpenAI({ text, tools }) {
  if (!OPENAI_API_KEY) return 'Try "tasks" or "clock in".';
  try {
    const { OpenAI } = require('openai');
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are Chief, a helpful CFO.' },
        { role: 'user', content: text },
      ],
      tools: tools || DEFAULT_TOOLS,
      max_tokens: 600,
    });
    const content = resp.choices?.[0]?.message?.content?.trim();
    return content || '';
  } catch (e) {
    console.warn('[agent] openai error:', e?.message);
    return '';
  }
}

async function _askGrok(opts) {
  // placeholder – falls back to OpenAI
  return _askOpenAI(opts);
}

async function ask({ from, ownerId, text, topicHints = [], userProfile }) {
  if (!canUseAgent(userProfile)) return '';
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000));
  try {
    const p = PROVIDER === 'openai' ? _askOpenAI({ text, tools: DEFAULT_TOOLS }) : _askGrok({ text, tools: DEFAULT_TOOLS });
    return await Promise.race([p, timeout]);
  } catch {
    return '';
  }
}

module.exports = { ask, canUseAgent };