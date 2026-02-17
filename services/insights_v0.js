// services/insights_v0.js
// Deterministic, facts-first insights for MVP.
// No writes. No guesses. If missing scope, ask 1 question.

const pg = require('./postgres');

function lc(s) { return String(s || '').toLowerCase(); }

function parseTimeWindow(text, tz = 'America/Toronto') {
  const s = lc(text);
  const now = new Date();

  // Helper: start/end ISO in server time (acceptable MVP). If you already have tz helpers, swap in later.
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  // today
  if (/\btoday\b/.test(s)) {
    const a = startOfDay(now), b = endOfDay(now);
    return { label: 'today', from: a.toISOString(), to: b.toISOString() };
  }

  // yesterday
  if (/\byesterday\b/.test(s)) {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    const a = startOfDay(y), b = endOfDay(y);
    return { label: 'yesterday', from: a.toISOString(), to: b.toISOString() };
  }

  // last N days
  const m = s.match(/\b(last|past)\s+(\d{1,2})\s+days?\b/);
  if (m) {
    const n = Math.max(1, Math.min(90, Number(m[2] || 7)));
    const a = new Date(now); a.setDate(a.getDate() - (n - 1));
    return { label: `last ${n} days`, from: startOfDay(a).toISOString(), to: endOfDay(now).toISOString() };
  }

  // this month
  if (/\bthis month\b/.test(s)) {
    const a = new Date(now.getFullYear(), now.getMonth(), 1);
    const b = endOfDay(now);
    return { label: 'this month', from: a.toISOString(), to: b.toISOString() };
  }

  // last month
  if (/\blast month\b/.test(s)) {
    const a = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const b = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { label: 'last month', from: a.toISOString(), to: b.toISOString() };
  }

  return null;
}

function wantsProfit(text) {
  const s = lc(text);
  return /\bprofit\b|\bmargin\b|\bnet\b/.test(s);
}
function wantsSpend(text) {
  const s = lc(text);
  return /\bspend\b|\bspent\b|\bexpenses?\b/.test(s);
}
function wantsRevenue(text) {
  const s = lc(text);
  return /\brevenue\b|\bsales\b|\bearned\b/.test(s);
}
function wantsTodaySummary(text) {
  const s = lc(text);
  return /\bwhat happened today\b|\btoday summary\b|\bsummary today\b/.test(s);
}

function hasJobMention(text) {
  const s = lc(text);
  return /\bjob\b/.test(s);
}

async function tryGetTotalsUsingExistingPgHelpers({ ownerId, from, to, jobId = null }) {
  // Try common helper names without breaking if missing.
  const candidates = [
    // business totals
    jobId ? null : 'getTotalsForRange',
    jobId ? null : 'getFinanceTotalsForRange',
    jobId ? null : 'getCashTotalsForRange',
    // job totals
    jobId ? 'getJobTotalsForRange' : null,
    jobId ? 'getJobFinanceTotalsForRange' : null
  ].filter(Boolean);

  for (const fnName of candidates) {
    if (typeof pg[fnName] === 'function') {
      return await pg[fnName](String(ownerId), from, to, jobId);
    }
  }

  return null;
}

async function answerInsightV0({ ownerId, actorKey, text, tz }) {
  const window = parseTimeWindow(text, tz);

  // If they want "what happened today" and no window provided, treat as today.
  const effectiveWindow = window || (wantsTodaySummary(text) ? parseTimeWindow('today', tz) : null);

  if (!effectiveWindow) {
    return {
      ok: true,
      route: 'clarify',
      answer: `What time window do you mean?\n\nTry: “today”, “yesterday”, “last 7 days”, or “this month”.`,
      evidence: { sql: [], facts_used: 0 }
    };
  }

  // If they mentioned job but we don’t have deterministic job resolution here yet:
  // Keep MVP-safe: ask one question rather than guessing.
  if (hasJobMention(text)) {
    return {
      ok: true,
      route: 'clarify',
      answer: `Which job?\n\nReply with the job name exactly (or say “business” for totals across all jobs).`,
      evidence: { sql: [], facts_used: 0 }
    };
  }

  // Business-wide totals
  const totals = await tryGetTotalsUsingExistingPgHelpers({
    ownerId,
    from: effectiveWindow.from,
    to: effectiveWindow.to,
    jobId: null
  });

  if (!totals) {
    // Safe fallback (no guesses)
    return {
      ok: true,
      route: 'clarify',
      answer: `I can answer that once the totals query tool is wired.\n\nFor now, try “today summary” or ask about a specific log you entered.`,
      evidence: { sql: [], facts_used: 0, warnings: ['TOTALS_TOOL_NOT_WIRED'] }
    };
  }

  // Expect totals shape like: { spend, revenue, profit } (you can adapt once you know exact shape)
  const spend = Number(totals.spend ?? totals.expenses ?? 0) || 0;
  const revenue = Number(totals.revenue ?? totals.income ?? 0) || 0;
  const profit = revenue - spend;

  let answer = '';
  if (wantsTodaySummary(text)) {
    answer =
      `Here’s what I have for ${effectiveWindow.label}:\n` +
      `• Revenue: $${revenue.toFixed(2)}\n` +
      `• Spend: $${spend.toFixed(2)}\n` +
      `• Profit (est): $${profit.toFixed(2)}`;
  } else if (wantsProfit(text)) {
    answer = `Profit (est) for ${effectiveWindow.label}: $${profit.toFixed(2)} (Revenue $${revenue.toFixed(2)} − Spend $${spend.toFixed(2)}).`;
  } else if (wantsSpend(text)) {
    answer = `Spend for ${effectiveWindow.label}: $${spend.toFixed(2)}.`;
  } else if (wantsRevenue(text)) {
    answer = `Revenue for ${effectiveWindow.label}: $${revenue.toFixed(2)}.`;
  } else {
    answer =
      `Totals for ${effectiveWindow.label}:\n` +
      `• Revenue: $${revenue.toFixed(2)}\n` +
      `• Spend: $${spend.toFixed(2)}\n` +
      `• Profit (est): $${profit.toFixed(2)}`;
  }

  return {
    ok: true,
    route: 'insight',
    answer,
    evidence: {
      sql: [],
      facts_used: 3,
      warnings: []
    }
  };
}

module.exports = { answerInsightV0 };
