// services/answerSupport.js
// Answers product support questions (how-to, feature help, troubleshooting) without
// consuming Ask Chief quota. Two-layer strategy:
//   1. RAG over doc_chunks (grounded in uploaded docs)
//   2. Haiku fallback with embedded ChiefOS product knowledge (catches sparse/empty doc_chunks)

const { ragAnswer } = require("./rag_search");

// Minimum length for a RAG answer to be considered usable (avoids returning "I don't know" snippets)
const RAG_MIN_LENGTH = 30;

// Embedded ChiefOS product knowledge — kept tight so Haiku stays fast and cheap.
// Update this as features are added or pricing changes.
const CHIEFOS_KNOWLEDGE = `
ChiefOS is a WhatsApp-first business operating system for contractors and small businesses.
Every expense, revenue entry, and time log should be assigned to a Job so Chief can calculate per-job profit.

=== WHATSAPP COMMANDS ===
Log expense:      expense $50 Home Depot [Job Name]
Log revenue:      revenue $1200 received [Job Name]
Clock in:         clock in [Job Name]
Clock out:        clock out
Create task:      task [description] for [job]
Set reminder:     remind me to [thing] on [date]
Ask a question:   type naturally — "what's my profit this month?" or "job kpis [job name]"

=== PORTAL (app.usechiefos.com) ===
Dashboard:        overview of expenses, revenue, and job activity
Jobs:             create and manage jobs — always create a job before a project starts
Expenses:         view all logged expenses
Overhead:         set fixed recurring costs (rent, insurance, vehicle leases, subscriptions)
Time Clock:       review and edit hours logged by you and crew
Import:           bulk upload CSV files (expenses, revenue, time)
Tasks:            create and assign tasks to jobs or crew
Documents:        generate quotes, invoices, and contracts from job data (Starter+)
Settings > Team:  invite employees and manage roles
Settings > Billing: view plan, upgrade, or cancel

=== WHATSAPP SETUP (step by step) ===
1. Download WhatsApp — desktop (Windows/Mac) or mobile (iPhone/Android)
2. Add +1 (231) 680-2664 as a contact named "Chief"
3. Go to app.usechiefos.com/app/welcome — it will show a 4-6 digit link code
4. Send that code to Chief on WhatsApp
5. Tap "Already linked? Check now" on the welcome page to confirm the link

Troubleshooting: If the code expired, tap "New code" on the welcome page. Make sure you're texting the exact digits.

=== PLANS & PRICING ===
Free ($0/month):
  - 10 Ask Chief questions/month
  - Up to 3 jobs, 3 employees
  - Employee time clock via WhatsApp (all tiers include this)
  - Employee web portal (PWA)
  - Expense + revenue + time capture via WhatsApp
  - CSV export, 90-day history

Starter ($59/month):
  - 250 Ask Chief questions/month
  - Up to 25 jobs, 10 employees
  - Employee tasks & reminders
  - Employee mileage logging via WhatsApp
  - Employee job site photo submission
  - Receipt scanner (send a photo of a receipt on WhatsApp)
  - Voice expense logging (send a voice note)
  - Documents: quotes, invoices, contracts
  - Job site photos and notes
  - PDF/XLS/CSV exports, 3-year history
  - Bulk import

Pro ($149/month):
  - 2,000 Ask Chief questions/month
  - Unlimited jobs, up to 50 employees + 5 board members
  - Employee expense & revenue submission (goes to owner pending-review queue)
  - Crew self-logging via WhatsApp
  - Time entry approvals and edit requests
  - Forecasting
  - 7-year history

To upgrade: go to app.usechiefos.com/app/settings/billing

=== OVERHEAD ===
Overhead = fixed costs that run regardless of active jobs: rent, insurance, vehicle leases, software subscriptions.
Set up at app.usechiefos.com/app/overhead. Chief uses overhead to calculate your true job profitability.
If overhead is not set, job margins will appear higher than they actually are.

=== JOBS ===
Jobs are the core unit of ChiefOS. Create a job before starting a project. Link every expense, revenue entry,
and time log to a job. This lets Chief calculate per-job profit, margin, and cost breakdown.
To create a job: portal Jobs > New Job, or text Chief "create job [name]".

=== EXPENSES ===
How to log: text Chief "expense $50 Home Depot [Job Name]". Job name can be partial.
On Starter+: send a photo of the receipt — Chief reads it and asks you to confirm.
On Starter+: send a voice note describing the expense.
To view expenses: portal Expenses tab or text "show expenses [job name]".

=== TIME TRACKING ===
Clock in: text "clock in [Job Name]"
Clock out: text "clock out"
Chief logs the duration and links it to the job.
To review hours: portal Time Clock tab.

=== EMPLOYEES ===
Invite via portal: Settings > Team > Invite (send an SMS link or email magic link).
Employee time clock via WhatsApp is available on ALL plans (Free, Starter, Pro).
On Free: up to 3 employees — time clock only.
On Starter: up to 10 employees — time clock + tasks, mileage logging, job site photo submission.
On Pro: up to 50 employees + 5 board members — everything in Starter + expense/revenue submission (goes into a pending-review queue for the owner to approve or decline before it hits the books).
Board members can use all OS features but cannot access Ask Chief (financial intelligence is owner-only).
Employees get their own limited web portal — they can only see their own time, tasks, and submissions.

=== COMMON TROUBLESHOOTING ===
WhatsApp not linking:       Send the exact 4-6 digit code from the welcome page to +1 (231) 680-2664. Tap "New code" if expired.
Expense not appearing:      Check the Expenses tab. Make sure you included a job name in the message.
Job not found by Chief:     Make sure the job was created in the portal. Use the exact or partial job name.
Quota ran out:              Upgrade plan at Settings > Billing. Quota resets monthly.
`.trim();

async function answerSupport({ text, ownerId } = {}) {
  const q = String(text || "").trim();
  if (!q) return "";

  // Layer 1: RAG over doc_chunks (grounded in any uploaded documentation)
  try {
    const ragResult = await ragAnswer({ text: q, ownerId });
    if (ragResult && ragResult.length >= RAG_MIN_LENGTH) return ragResult;
  } catch (e) {
    console.warn("[SUPPORT] RAG failed (non-blocking):", e?.message);
  }

  // Layer 2: Claude Haiku with embedded product knowledge
  // Cheap ($0.25/1M input tokens), fast, grounded in CHIEFOS_KNOWLEDGE only
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return "";

    // Lazy-require to avoid module load cost on every request
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: [
        "You are Chief, the ChiefOS support assistant.",
        "Answer the user's question using ONLY the product knowledge provided below.",
        "Be concise — 2 to 5 sentences maximum.",
        "If the answer is not in the knowledge base, say exactly:",
        '  "I don\'t have that detail — visit usechiefos.com/help or contact support."',
        "Never invent features, prices, or commands that are not listed.",
        "",
        "=== CHIEFOS PRODUCT KNOWLEDGE ===",
        CHIEFOS_KNOWLEDGE,
      ].join("\n"),
      messages: [{ role: "user", content: q }],
    });

    return String(msg?.content?.[0]?.text || "").trim();
  } catch (e) {
    console.warn("[SUPPORT] Haiku fallback failed:", e?.message);
    return "";
  }
}

module.exports = { answerSupport };
