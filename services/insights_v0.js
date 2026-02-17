// services/insights_v0.js
// MVP-safe deterministic insights (NO hallucinations)

const pg = require('./postgres');

function lc(s) { return String(s || '').toLowerCase(); }

function money(cents) {
  const n = Number(cents || 0) / 100;
  // Keep it simple + stable for MVP
  return `$${n.toFixed(2)}`;
}

// -------------------- Job ref parsing + resolution (name-first friendly) --------------------

function normalizeJobRefToken(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^job\s+/i, '')
    .replace(/^#\s*/i, '')
    .trim();
}

// Pull job ref out of phrases like:
// - "profit on job 1556"
// - "profit on job 1556 medway park dr"
// - "profit on 1556"
// - "profit 1556 medway"
// - "margin on oak street"
function extractJobRefFromText(rawText) {
  const t = String(rawText || '').trim();
  const s = t.toLowerCase();

  // Prefer explicit "job ..."
  let m =
    t.match(/\b(?:profit|margin|making)\b[\s\S]*?\bjob\b\s*([#]?\s*\d+)?\s*([\s\S]+)?$/i) ||
    t.match(/\b(?:profit|margin|making)\b[\s\S]*?\bjob\b\s*([\s\S]+)$/i);

  if (m) {
    const maybeNo = normalizeJobRefToken(m[1] || '');
    const maybeName = normalizeJobRefToken(m[2] || '');
    const jobNo = /^\d+$/.test(maybeNo) ? Number(maybeNo) : null;
    const name = maybeName || null;
    // If they wrote only "job 1556" name is null; we still return jobNo
    return { jobNo, name, raw: normalizeJobRefToken((m[1] || '') + ' ' + (m[2] || '')) };
  }

  // No "job" word: allow "profit on 1556 ..." as job name fragment
  // (Only when the message is clearly a job-profit intent)
  const isProfitIntent =
    /\bprofit\b|\bmargin\b|\bhow much am i making\b|\bhow much are we making\b/i.test(s);

  if (isProfitIntent) {
    // capture "profit on <something>"
    const m2 = t.match(/\b(?:profit|margin|making)\b[\s\S]*?\bon\b\s*([\s\S]+)$/i);
    if (m2) {
      const token = normalizeJobRefToken(m2[1] || '');
      if (token) {
        // If they just said a number, treat it as a name fragment too (fallback later)
        const jobNo = /^\d+$/.test(token) ? Number(token) : null;
        return { jobNo, name: token, raw: token };
      }
    }

    // capture "profit <something>"
    const m3 = t.match(/^\s*(?:profit|margin)\s+([\s\S]+)$/i);
    if (m3) {
      const token = normalizeJobRefToken(m3[1] || '');
      if (token) {
        const jobNo = /^\d+$/.test(token) ? Number(token) : null;
        return { jobNo, name: token, raw: token };
      }
    }
  }

  return { jobNo: null, name: null, raw: null };
}

// Resolve job by:
// 1) exact job_no if provided
// 2) exact name (case-insensitive) (via existing resolveJobRow if you want)
// 3) name fragment search (ILIKE %term%) INCLUDING numeric fragments like "1556"
async function resolveJobForInsight(pg, ownerId, ref) {
  const owner = String(ownerId || '').trim();
  if (!owner) return { ok: false, reason: 'missing_owner' };

  const jobNo = ref?.jobNo != null && Number.isFinite(Number(ref.jobNo)) ? Number(ref.jobNo) : null;
  const name = ref?.name ? String(ref.name).trim() : null;

  // 1) Try job_no direct
  if (jobNo != null) {
    try {
      const r = await pg.query(
        `
        select id, job_no, coalesce(name, job_name) as job_name
        from public.jobs
        where owner_id::text = $1 and job_no = $2
        limit 1
        `,
        [owner, jobNo]
      );
      if (r?.rows?.[0]) return { ok: true, job: r.rows[0], mode: 'job_no' };
    } catch {}
  }

  // 2) Try exact name match if we have a name
  if (name) {
    try {
      const r = await pg.query(
        `
        select id, job_no, coalesce(name, job_name) as job_name
        from public.jobs
        where owner_id::text = $1
          and lower(coalesce(name, job_name)) = lower($2)
        order by updated_at desc nulls last, created_at desc
        limit 1
        `,
        [owner, name]
      );
      if (r?.rows?.[0]) return { ok: true, job: r.rows[0], mode: 'exact_name' };
    } catch {}
  }

  // 3) Name fragment fallback (this is the key fix)
  // If they said only a number (e.g. "1556"), search for jobs containing "1556" in name.
  const term = (name || (jobNo != null ? String(jobNo) : '')).trim();
  if (term) {
    try {
      const r = await pg.query(
        `
        select id, job_no, coalesce(name, job_name) as job_name, active, status
        from public.jobs
        where owner_id::text = $1
          and lower(coalesce(name, job_name)) like lower($2)
        order by active desc nulls last, updated_at desc nulls last, created_at desc
        limit 5
        `,
        [owner, `%${term}%`]
      );
      const rows = r?.rows || [];
      if (rows.length === 1) return { ok: true, job: rows[0], mode: 'name_contains' };
      if (rows.length > 1) return { ok: false, reason: 'ambiguous', matches: rows, term };
    } catch {}
  }

  return { ok: false, reason: 'not_found' };
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
  // Use the new smarter extractor (supports "profit on 1556", "profit on job 1556", "profit on oak street", etc.)
  const ref = extractJobRefFromText(text);

  const resolved = await resolveJobForInsight(pg, ownerId, ref);

  if (resolved?.ok && resolved?.job) {
    return {
      jobNo: Number(resolved.job.job_no),
      jobName: resolved.job.job_name || null,
      source: resolved.mode || 'resolved'
    };
  }

  // Ambiguous matches: tell caller we need clarification, but return matches so it can list options
  if (resolved?.reason === 'ambiguous') {
    return {
      jobNo: null,
      jobName: null,
      source: 'ambiguous',
      matches: resolved.matches || [],
      term: resolved.term || ref?.raw || ''
    };
  }

  // If they asked "profit on active job" keep your existing active job fallback (nice UX)
  // (The helper *can* handle active job if you add it, but keeping your current fallback is fine.)
  try {
    if (typeof pg.getActiveJob === 'function') {
      const aj = await pg.getActiveJob(ownerId, actorKey);
      if (aj && typeof aj === 'object' && aj.job_no != null) {
        return { jobNo: Number(aj.job_no), jobName: aj.name || null, source: 'active_job' };
      }
    }
  } catch {}

  return { jobNo: null, jobName: null, source: resolved?.reason || 'none' };
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
    // Handle ambiguous name/number fragments ("1559" could match multiple jobs)
  if (resolved?.source === 'ambiguous' && Array.isArray(resolved.matches) && resolved.matches.length) {
    const lines = resolved.matches.slice(0, 5).map((j) => `- #${j.job_no} ${j.job_name}`);
    return {
      ok: true,
      route: 'clarify',
      answer:
        `I found a few jobs matching "${resolved.term}". Which one?\n\n` +
        lines.join('\n') +
        `\n\nReply like: “profit on job #<number>”.`,
      evidence: { sql: [], facts_used: 0 }
    };
  }

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

  const profitIntent =
    /\bprofit\b|\bmargin\b|\bhow much am i making\b|\bhow much are we making\b/.test(s);

  // allow:
  // - "profit on job 18"
  // - "profit on #18"
  // - "profit on 1556"
  // - "profit on 1556 medway"
  const hasJobSignal =
    /\bjob\b/.test(s) ||
    /(^|\s)#\d+\b/.test(s) ||
    /\bactive job\b/.test(s) ||
    /\bprofit\b[\s\S]*\bon\b\s*\d+\b/.test(s) ||      // "profit on 1556"
    /^\s*(profit|margin)\s+\d+\b/.test(s);            // "profit 1556"

  return profitIntent && hasJobSignal;
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
