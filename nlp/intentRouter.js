// nlp/intentRouter.js  
const OpenAI = require("openai");  
const { looksLikeTask, parseTaskUtterance } = require("./task_intents"); // ← NEW  

const INTENT_ROUTER_FALLBACK_ENABLED = /^true$/i.test(process.env.INTENT_ROUTER_FALLBACK_ENABLED || 'true');  

const client = process.env.OPENAI_API_KEY  
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })  
  : null;  

// Keep tools literal and narrow to avoid hallucinations.  
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
          when: { type: "string", description: "Natural time like 'now' or '7:30am'" }  
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
          name: { type: "string", description: "Job name or address" }  
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
  },  

  // Optional: let AI surface task list & broadcast when fuzzy match is unsure.  
  {  
    type: "function",  
    function: {  
      name: "tasks_list",  
      description: "Show the tasks assigned to the requester.",  
      parameters: { type: "object", properties: {}, additionalProperties: false }  
    }  
  },  
  {  
    type: "function",  
    function: {  
      name: "tasks_assign_all",  
      description: "Create a task for all teammates.",  
      parameters: {  
        type: "object",  
        properties: {  
          title: { type: "string", description: "The task text to send to everyone" }  
        },  
        required: ["title"]  
      }  
    }  
  },  

  // Optional extras you referenced elsewhere:  
  {  
    type: "function",  
    function: {  
      name: "quote_send",  
      description: "Send a quote to a client.",  
      parameters: {  
        type: "object",  
        properties: {  
          client: { type: "string" },  
          quote_id: { type: "string" }  
        },  
        required: ["client", "quote_id"]  
      }  
    }  
  },  
  {  
    type: "function",  
    function: {  
      name: "budget_set",  
      description: "Set a budget for a job.",  
      parameters: {  
        type: "object",  
        properties: {  
          job: { type: "string" },  
          amount: { type: "number" }  
        },  
        required: ["job", "amount"]  
      }  
    }  
  },  
  {  
    type: "function",  
    function: {  
      name: "memory_forget",  
      description: "Forget a stored key (e.g., alias.vendor.hd).",  
      parameters: {  
        type: "object",  
        properties: { key: { type: "string" } },  
        required: ["key"]  
      }  
    }  
  },  
  {  
    type: "function",  
    function: {  
      name: "memory_show",  
      description: "Show what the assistant remembers for this user.",  
      parameters: { type: "object", properties: {}, additionalProperties: false }  
    }  
  }  
];  

const SYSTEM = `  
You are a STRICT command router for a bookkeeping & field-ops assistant (Chief AI).  
Only call a tool if you are >95% confident the user is asking for that exact action.  
If you are not >95% confident, do NOT call any tool and reply with the single word: none.  
Never infer money amounts or invent people. Avoid over-eager matches.  
`;  

/**  
 * routeWithAI(text, context) -> { intent, args } | null  
 * Returns null if no OPENAI_API_KEY, if the model declines, or if no tool was called.  
 */  
async function routeWithAI(text, context = {}) {  
  if (!client) return null;  

  try {  
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";  

    const messages = [  
      { role: "system", content: SYSTEM.trim() },  
      ...(context?.userProfile?.name ? [{ role: "system", content: `User name: ${context.userProfile.name}` }] : []),  
      { role: "user", content: text }  
    ];  

    const resp = await client.chat.completions.create({  
      model,  
      temperature: 0,  
      messages,  
      tools,  
      tool_choice: "auto",  
      max_tokens: 100,  
    });  

    const msg = resp.choices?.[0]?.message;  
    if (!msg) return null;  

    // If the model followed the instruction to say "none"  
    if (typeof msg.content === "string" && msg.content.trim().toLowerCase() === "none") {  
      return null;  
    }  

    const call = msg.tool_calls?.[0];  
    if (!call) return null;  

    const name = call.function?.name || call.name;  
    let args = {};  
    try { args = JSON.parse(call.function?.arguments || call.arguments || "{}"); }  
    catch { args = {}; }  

    switch (name) {  
      case "timeclock_clock_in":   return { intent: "timeclock.clock_in",   args };  
      case "timeclock_clock_out":  return { intent: "timeclock.clock_out",  args };  
      case "job_create":           return { intent: "job.create",           args };  
      case "expense_add":          return { intent: "expense.add",          args };  
      case "tasks_list":           return { intent: "tasks.list",           args };  
      case "tasks_assign_all":     return { intent: "tasks.assign_all",     args };  
      case "quote_send":           return { intent: "quote.send",           args };  
      case "budget_set":           return { intent: "budget.set",           args };  
      case "memory_forget":        return { intent: "memory.forget",        args };  
      case "memory_show":          return { intent: "memory.show",          args };  
      default: return null;  
    }  
  } catch (err) {  
    console.warn("[intentRouter] AI route error:", err?.message);  
    return null;  
  }  
}  

/**  
 * route(text, context) -> { intent, args } | null  
 * Deterministic fast-path → then AI tools → else null.  
 */  
async function route(text, context = {}) {  
  const t = String(text || "").trim();  
  if (!t) return null;  

  // 1) Deterministic "task" fast-path FIRST (prevents falling into expense/timesheet prompts)  
  if (looksLikeTask(t)) {  
    const parsed = parseTaskUtterance(t, { tz: context.tz || "America/Toronto", now: context.now });  
    // We only parse here. Creation happens in conversation.js / handler.  
    return {  
      intent: "tasks.create_from_utterance",  
      args: {  
        title: parsed.title,  
        dueAt: parsed.dueAt,  
        assigneeName: parsed.assignee,  
      }  
    };  
  }  

  // 2) Otherwise, try the strict tool-based router  
  const ai = await routeWithAI(t, context);  
  if (ai) return ai;  

  // 3) No match  
  return null;  
}  

module.exports = { route, routeWithAI };  