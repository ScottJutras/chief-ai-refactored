const pg = require('./postgres');

// --- small helpers ---
function normText(s) {
  return String(s || '').trim().toLowerCase();
}

function centsToMoney(cents, currency = 'CAD') {
  if (cents == null || !Number.isFinite(Number(cents))) return null;
  const v = Number(cents) / 100;
  // Keep deterministic formatting; avoid locale surprises in serverless
  return `${currency} ${v.toFixed(2)}`;
}

function parseJobNo(text) {
  const m = String(text || '').match(/\bjob\s*#?\s*(\d{1,10})\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseDays(text) {
  // minimal: "last 7 days", "past 30", "this week"
  const t = normText(text);
  const m = t.match(/\b(last|past)\s+(\d{1,3})\s*(day|days)\b/);
  if (m) return Math.max(1, Math.min(365, Number(m[2])));

  if (t.includes('this week')) return 7;
  if (t.includes('last week')) return 7;
  if (t.includes('this month')) return 30;
  if (t.includes('last month')) return 30;

  // default for cashflow intent
  return null;
}

function isCashflowQuestion(text) {
  const t = normText(text);
  return (
    t.includes('cashflow') ||
    t.includes('cash flow') ||
    t.includes('net') ||
    t.includes('profit') && (t.includes('week') || t.includes('month') || t.includes('days')) ||
    t.includes('revenue') && (t.includes('minus') || t.includes('less') || t.includes('net'))
  );
}

function isJobProfitQuestion(text) {
  const t = normText(text);
  return (t.includes('profit') || t.includes('margin')) && (t.includes('job') || /\bjob\s*#?\s*\d+/.test(t));
}

function isWhatHappenedQuestion(text) {
  const t = normText(text);
  return (
    t.includes('what happened') ||
    t.includes('what did i log') ||
    t.includes('today') ||
    t.includes('latest activity') ||
    t.includes('recent')
  );
}

function summarizeCashflow(rows, currencyFallback = 'CAD') {
  if (!rows || rows.length === 0) {
    return {
      answer: `I don’t have any confirmed revenue/expense facts in that window yet.`,
      evidence: { facts_used: 0 }
    };
  }

  const totalRev = rows.reduce((a, r) => a + Number(r.revenue_cents || 0), 0);
  const totalExp = rows.reduce((a, r) => a + Number(r.expense_cents || 0), 0);
  const net = totalRev - totalExp;

  const firstDay = rows[0].day;
  const lastDay = rows[rows.length - 1].day;

  const currency = currencyFallback; // facts may not have currency per-day; keep deterministic
  const ans =
    `From ${new Date(firstDay).toISOString().slice(0,10)} to ${new Date(lastDay).toISOString().slice(0,10)}:\n` +
    `• Revenue: ${centsToMoney(totalRev, currency)}\n` +
    `• Expenses: ${centsToMoney(totalExp, currency)}\n` +
    `• Net: ${centsToMoney(net, currency)}`;

  return {
    answer: ans,
    evidence: {
      facts_used: rows.length,
      time_range: {
        from: new Date(firstDay).toISOString(),
        to: new Date(lastDay).toISOString()
      }
    }
  };
}

function summarizeJobProfit(row) {
  if (!row) {
    return { answer: `I don’t have confirmed revenue/expense facts for that job yet.`, evidence: { facts_used: 0 } };
  }
  const currency = row.currency || 'CAD';
  const ans =
    `Job ${row.job_no} (${row.job_name || 'Unnamed'}):\n` +
    `• Revenue: ${centsToMoney(row.revenue_cents || 0, currency)}\n` +
    `• Expenses: ${centsToMoney(row.expense_cents || 0, currency)}\n` +
    `• Profit: ${centsToMoney(row.profit_cents || 0, currency)}`;

  return { answer: ans, evidence: { facts_used: 1 } };
}

function summarizeLatestFacts(rows) {
  if (!rows || rows.length === 0) {
    return { answer: `No recent fact events found yet.`, evidence: { facts_used: 0 } };
  }
  const lines = rows.slice(0, 10).map((r) => {
    const dt = (r.occurred_at || r.recorded_at || '').toString();
    const job = r.job_no ? ` job ${r.job_no}` : '';
    const amt = r.amount_cents != null ? ` ${centsToMoney(r.amount_cents, r.currency || 'CAD')}` : '';
    return `• ${r.event_type}${job}${amt}`;
  });
  return { answer: `Latest activity:\n${lines.join('\n')}`, evidence: { facts_used: rows.length } };
}

// --- main ---
async function answer({ ownerId, actorKey, text, tz = 'America/Toronto', jobNo = null }) {
  const owner_id = String(ownerId || '').trim();
  const actor_key = String(actorKey || '').trim(); // not always needed, but keep for future personalization
  const qtext = String(text || '').trim();

  if (!owner_id || !qtext) return { ok: false, error: 'missing ownerId or text' };

  // INTENT ROUTING (v0)
  try {
    // 1) Job profit
    if (isJobProfitQuestion(qtext)) {
      const parsedJobNo = jobNo || parseJobNo(qtext);
      if (!parsedJobNo) {
        return {
          ok: true,
          answer: `Which job number? Example: “Profit on job 1556”.`,
          evidence: { sql: [], facts_used: 0 }
        };
      }

      const r = await pg.getJobProfitSimple({ ownerId: owner_id, jobNo: parsedJobNo });
      const row = r?.rows?.[0] || null;

      const s = summarizeJobProfit(row);
      return {
        ok: true,
        answer: s.answer,
        evidence: { sql: ['v_job_profit_simple'], facts_used: s.evidence.facts_used }
      };
    }

    // 2) Cashflow
    if (isCashflowQuestion(qtext)) {
      const days = parseDays(qtext) || 30;
      const r = await pg.getCashflowDaily({ ownerId: owner_id, days });
      const rows = r?.rows || [];

      const s = summarizeCashflow(rows);
      return {
        ok: true,
        answer: s.answer,
        evidence: { sql: ['v_cashflow_daily'], facts_used: s.evidence.facts_used, time_range: s.evidence.time_range }
      };
    }

    // 3) Latest activity / today
    if (isWhatHappenedQuestion(qtext)) {
      // Keep simple: latest 20 facts (any type)
      const r = await pg.getLatestFacts({ ownerId: owner_id, limit: 20 });
      const rows = r?.rows || [];
      const s = summarizeLatestFacts(rows);

      return {
        ok: true,
        answer: s.answer,
        evidence: { sql: ['fact_events latest'], facts_used: s.evidence.facts_used }
      };
    }

    // unsupported
    return { ok: false, error: 'unsupported_intent' };
  } catch (e) {
    return { ok: false, error: e?.message || 'brain error' };
  }
}

module.exports = { answer };
