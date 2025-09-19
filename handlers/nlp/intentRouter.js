// nlp/intentRouter.js
const OpenAI = require("openai");

const client =
  process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Describe the commands you want the model to call.
// Keep these tight and literal to reduce hallucinations.
const tools = [
  {
    type: "function",
    function: {
      name: "timeclock_clock_in",
      description: "Clock a team member in for work.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string", description: "Team member name or nickname" },
          job: { type: "string", description: "Optional job/address to associate" },
          when: { type: "string", description: "Natural language time, e.g. 'now', '7:30am'" }
        },
        required: ["person"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "timeclock_clock_out",
      description: "Clock a team member out of work (optionally with notes).",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string" },
          notes: { type: "string" }
        },
        required: ["person"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "job_create",
      description: "Create a new job / work order.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Job name (e.g., address or short title)" }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "expense_add",
      description: "Record an expense.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Amount in dollars (e.g., 100.00)" },
          merchant: { type: "string" },
          category: { type: "string" },
          job: { type: "string" }
        },
        required: ["amount"]
      }
    }
  }
  // Add more (revenue_add, bill_add, metrics_query, team_add, quote_create, tax_*...) as you like
];

// Minimal, deterministic system rules.
const SYSTEM = `
You are a STRICT command router for a bookkeeping & field-ops assistant (Chief AI).
Only call a tool if you are >95% confident. Otherwise, return plain text saying "none".
Never infer money amounts. Never invent people. Avoid over-eager matches.
`;

/**
 * routeWithAI(text, context) -> { intent, args } | null
 * Returns null if no OPENAI_API_KEY or if the model doesn’t call a tool.
 */
async function routeWithAI(text, context = {}) {
  if (!client) return null;

  const msgs = [
    { role: "system", content: SYSTEM.trim() },
    {
      role: "user",
      content: text
    }
  ];

  // Prefer a small, fast model; adjust via OPENAI_MODEL if you want.
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const resp = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: msgs,
    tools,
    tool_choice: "auto"
  });

  const msg = resp.choices?.[0]?.message || {};
  const call = msg.tool_calls?.[0] || null;
  if (!call) return null;

  // Works with current tool-calling shape
  const name = call.function?.name || call.name;
  let args = {};
  try {
    args = JSON.parse(call.function?.arguments || call.arguments || "{}");
  } catch {
    args = {};
  }

  switch (name) {
    case "timeclock_clock_in":
      return { intent: "timeclock.clock_in", args };
    case "timeclock_clock_out":
      return { intent: "timeclock.clock_out", args };
    case "job_create":
      return { intent: "job.create", args };
    case "expense_add":
      return { intent: "expense.add", args };
    default:
      return null;
  }
}

module.exports = { routeWithAI };
