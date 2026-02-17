// services/insights_v0.js
// MVP-safe deterministic insights (NO hallucinations)

const pg = require('./postgres');

function lc(s) { return String(s || '').toLowerCase(); }

function money(cents) {
  const n = Number(cents || 0) / 100;
  // Keep it simple + stable for MVP
  return `$${n.toFixed(2)}`;
}

function pct(x) {
  if (x == null) return null;
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return `${n.toFixed(1)}%`;
}

// Extract job ref from text (job_no or job name tail)
function parseJobRef(rawText) {
  const t = String(rawText || '').trim();
  const s = lc(t);

  // job 18, job #18, #18
  let m = s.match(/\bjob\s*#?\s*(\d+)\b/);
  if (m?.[1]) return { jobNo: Number(m[1]), jobName: null };

  m = s.match(/(^|\s)#\s*(\d+)\b/);
  if (m?.[2]) return { jobNo: Number(m[2]), jobName: null };

  // "profit on job 18 main st" -> jobNo=18 (already captured above)
  // job name tail: "job <name...>"
  m = t.match(/\bjob\b\s*(?:#\s*)?\d*\s*(.+)$/i);
  if (m?.[1]) {
    const name = String(m[1] || '').trim();
    // Avoid capturing generic words like "job" only
    if (name && name.length >= 3) return { jobNo: null, jobName: name };
  }

  return { jobNo: null, jobName: null };
}

async function resolveJobForProfit({ ownerId, actorKey, text }) {
  const { jobNo, jobName } = parseJobRef(text);

  // 1) Explicit job_no
  if (jobNo != null && Number.isFinite(jobNo)) {
    return { jobNo, jobName: null, source: 'explicit_job_no' };
  }

  // 2) Explicit job name (best-effort resolve to job_no if possible)
  if (jobName) {
    try {
      if (typeof pg.ensureJobByName === 'function') {
        const j = await pg.ensureJobByName(ownerId, jobName);
        if (j?.job_no != null) return { jobNo: Number(j.job_no), jobName: j.name || jobName, source: 'name_resolved' };
      }
    } catch {}
    return { jobNo: null, jobName, source: 'explicit_name_unresolved' };
  }

  // 3) Fallback: active job (per-user if available, else owner-wide)
  try {
    if (typeof pg.getActiveJob === 'function') {
      const aj = await pg.getActiveJob(ownerId, actorKey);
      // getActiveJob sometimes returns string name if userId omitted; handle both
      if (aj && typeof aj === 'object' && aj.job_no != null) {
        return { jobNo: Number(aj.job_no), jobName: aj.name || null, source: 'active_job' };
      }
    }
  } catch {}

  return { jobNo: null, jobName: null, source: 'none' };
}

async function getProfitRowByJobNo(ownerId, jobNo) {
  // Preferred: view-backed helper
  if (typeof pg.getJobProfitSimple === 'function') {
    const r = await pg.getJobProfitSimple({ ownerId, jobNo, limit: 1 });
    const row = r?.rows?.[0] || null;
    if (row) return row;
  }
  return null;
}

function profitReply({ row, label }) {
  const revenue = Number(row.revenue_cents) || 0;
  const expense = Number(row.expense_cents) || 0;
  const profit = Number(row.profit_cents) || (revenue - expense);

  // view may provide margin_pct already; else compute
  const marginPct =
    row.margin_pct != null
      ? Number(row.margin_pct)
      : (revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : null);

  const jobLabel =
    label ||
    row.job_name ||
    (row.job_no != null ? `Job #${row.job_no}` : 'That job');

  const lines = [
    `📌 ${jobLabel}`,
    ``,
    `Revenue: ${money(revenue)}`,
    `Spend: ${money(expense)}`,
    `Profit: ${money(profit)}${marginPct != null ? ` (${pct(marginPct)})` : ``}`
  ];

  return lines.join('\n');
}

async function answerProfitIntent({ ownerId, actorKey, text }) {
  const resolved = await resolveJobForProfit({ ownerId, actorKey, text });

  // If we have a job_no, we can answer deterministically
  if (resolved.jobNo != null) {
    const row = await getProfitRowByJobNo(ownerId, resolved.jobNo);
    if (row) {
      return {
        ok: true,
        route: 'insight',
        answer: profitReply({
          row,
          label: row.job_name || resolved.jobName || `Job #${resolved.jobNo}`
        }),
        evidence: { sql: ['v_job_profit_simple/getJobProfitSimple'], facts_used: 4 }
      };
    }

    // If job_no not found in view, fail-safe
    return {
      ok: true,
      route: 'clarify',
      answer: `I couldn’t find Job #${resolved.jobNo}. Try “list jobs” or tell me the job name.`,
      evidence: { sql: [], facts_used: 0 }
    };
  }

  // If they gave a name but we couldn't resolve: ask one question (MVP safe)
  if (resolved.jobName) {
    return {
      ok: true,
      route: 'clarify',
      answer: `Do you mean a specific job? Reply with the job number like “job 18”, or say “active job”.`,
      evidence: { sql: [], facts_used: 0 }
    };
  }

  // No job provided and no active job
  // Provide a helpful fallback: show top jobs by profit if available
  try {
    if (typeof pg.getJobProfitSimple === 'function') {
      const r = await pg.getJobProfitSimple({ ownerId, jobNo: null, limit: 5 });
      const rows = r?.rows || [];
      if (rows.length) {
        const lines = [
          `Which job? Reply like “profit on job 18”.`,
          ``,
          `Top jobs by profit:`
        ];
        for (const x of rows) {
          const jn = x.job_no != null ? `#${x.job_no}` : '';
          const nm = x.job_name ? String(x.job_name) : '(Unnamed)';
          const pf = money(x.profit_cents);
          lines.push(`• ${jn} ${nm} — ${pf}`);
        }
        return { ok: true, route: 'clarify', answer: lines.join('\n'), evidence: { sql: ['v_job_profit_simple'], facts_used: rows.length } };
      }
    }
  } catch {}

  return {
    ok: true,
    route: 'clarify',
    answer: `Which job are you asking about? Reply like “profit on job 18” or “profit on active job”.`,
    evidence: { sql: [], facts_used: 0 }
  };
}

function looksLikeProfitQuestion(text) {
  const s = lc(text);
  return (
    /\bprofit\b|\bmargin\b|\bhow much am i making\b|\bhow much are we making\b/.test(s) &&
    /\bjob\b|(^|\s)#\d+\b|\bactive job\b/.test(s)
  );
}

async function answerInsightV0({ ownerId, actorKey, text, tz }) {
  const raw = String(text || '').trim();
  const s = lc(raw);

  // -------------------------------------------------------
  // 1) Job profit / margin (Phase 2)
  // -------------------------------------------------------
  if (looksLikeProfitQuestion(raw)) {
    return await answerProfitIntent({ ownerId, actorKey, text: raw });
  }

  // -------------------------------------------------------
  // 2) Spend / revenue totals (Phase 1)
  // (uses pg.getTotalsForRange you already wired)
  // -------------------------------------------------------
  if (typeof pg.getTotalsForRange === 'function') {
    // Spend today
    if (/\bspend\b/.test(s) && /\btoday\b/.test(s)) {
      const r = await pg.getTotalsForRange({
        ownerId,
        kind: 'expense',
        preset: 'today',
        tz: tz || 'America/Toronto'
      });
      const cents = Number(r?.total_cents) || 0;
      return { ok: true, route: 'insight', answer: `Spend for today ${money(cents)}`, evidence: { sql: ['getTotalsForRange(today)'], facts_used: 1 } };
    }
  }

  // Default MVP safe clarify
  return {
    ok: true,
    route: 'clarify',
    answer: `Try: “spend today” or “profit on job 18”.`,
    evidence: { sql: [], facts_used: 0 }
  };
}

module.exports = { answerInsightV0 };
