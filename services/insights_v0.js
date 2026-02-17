// services/insights_v0.js
// MVP-safe deterministic insights (NO hallucinations)

const pg = require('./postgres');

function lc(s) {
  return String(s || '').toLowerCase();
}

function money(cents) {
  const n = Number(cents || 0) / 100;
  return `$${n.toFixed(2)}`;
}

function pct(x) {
  if (x == null) return null;
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return `${n.toFixed(1)}%`;
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
// - "how much am i making on oak st"
function extractJobRefFromText(rawText) {
  const t = String(rawText || '').replace(/\s+/g, ' ').trim();
  const s = t.toLowerCase();

  // Prefer explicit "job ..."
  // ex: "profit on job 18 main st", "margin job #12"
  let m =
    t.match(/\b(?:profit|margin|making)\b[\s\S]*?\bjob\b\s*([#]?\s*\d+)?\s*([\s\S]+)?$/i) ||
    t.match(/\b(?:profit|margin|making)\b[\s\S]*?\bjob\b\s*([\s\S]+)$/i);

  if (m) {
    const maybeNo = normalizeJobRefToken(m[1] || '');
    const maybeName = normalizeJobRefToken(m[2] || '');
    const jobNo = /^\d+$/.test(maybeNo) ? Number(maybeNo) : null;
    const name = maybeName || null;

    return {
      jobNo,
      name,
      raw: normalizeJobRefToken((m[1] || '') + ' ' + (m[2] || ''))
    };
  }

  // No "job" word: allow "making on <term>", "profit on <term>"
  const isProfitIntent =
    /\bprofit\b|\bmargin\b|\bhow much am i making\b|\bhow much are we making\b|\bwhat am i making\b|\bmaking\b/i.test(s);

  if (isProfitIntent) {
    // capture "... on <something>"
    const m2 = t.match(/\bon\b\s+([\s\S]+)$/i);
    if (m2) {
      const token = normalizeJobRefToken(m2[1] || '');
      // If they said "on job 12", let job parsing handle it elsewhere; here treat as name only
      if (token && !/^job\b/i.test(token)) {
        const jobNo = /^\d+$/.test(token) ? Number(token) : null;
        return { jobNo, name: token, raw: token };
      }
    }

    // capture "profit <something>" / "margin <something>"
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
// 2) exact name (case-insensitive)
// 3) name fragment search (ILIKE %term%) INCLUDING numeric fragments like "1556"
async function resolveJobForInsight(pgClient, ownerId, ref) {
  const owner = String(ownerId || '').trim();
  if (!owner) return { ok: false, reason: 'missing_owner' };

  const jobNo =
    ref?.jobNo != null && Number.isFinite(Number(ref.jobNo)) ? Number(ref.jobNo) : null;

  const name = ref?.name ? String(ref.name).trim() : null;

  // 1) Try job_no direct (NOTE: in your system job_no is the #1/#2 numbering)
  if (jobNo != null) {
    try {
      const r = await pgClient.query(
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
      const r = await pgClient.query(
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

  // 3) Name fragment fallback (key behavior)
  // If they said only a number (e.g. "1556"), search for jobs containing "1556" in the name,
  // and rank matches that START with the term above "contains".
  const term = (name || (jobNo != null ? String(jobNo) : '')).trim();
  if (term) {
    try {
      const r = await pgClient.query(
        `
        select id, job_no, coalesce(name, job_name) as job_name, active, status
        from public.jobs
        where owner_id::text = $1
          and lower(coalesce(name, job_name)) like lower($2)
        order by
          case
            when lower(coalesce(name, job_name)) like lower($3) then 0 -- starts with term
            else 1
          end,
          active desc nulls last,
          updated_at desc nulls last,
          created_at desc
        limit 5
        `,
        [owner, `%${term}%`, `${term}%`]
      );

      const rows = r?.rows || [];
      if (rows.length === 1) return { ok: true, job: rows[0], mode: 'name_contains' };
      if (rows.length > 1) return { ok: false, reason: 'ambiguous', matches: rows, term };
    } catch {}
  }

  return { ok: false, reason: 'not_found' };
}

async function resolveJobForProfit({ ownerId, actorKey, text }) {
  const ref = extractJobRefFromText(text);
  const resolved = await resolveJobForInsight(pg, ownerId, ref);

  if (resolved?.ok && resolved?.job) {
    return {
      jobNo: Number(resolved.job.job_no),
      jobName: resolved.job.job_name || null,
      source: resolved.mode || 'resolved'
    };
  }

  if (resolved?.reason === 'ambiguous') {
    return {
      jobNo: null,
      jobName: null,
      source: 'ambiguous',
      matches: resolved.matches || [],
      term: resolved.term || ref?.raw || ''
    };
  }

  // Active job fallback
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
  if (!Number.isFinite(jobNo)) return null; // hard stop

  if (typeof pg.getJobProfitSimple === 'function') {
    const r = await pg.getJobProfitSimple({ ownerId, jobNo, limit: 1 });
    return r?.rows?.[0] || null;
  }
  return null;
}

function profitReply({ row, label }) {
  const revenue = Number(row.revenue_cents) || 0;
  const expense = Number(row.expense_cents) || 0;
  const profit = Number(row.profit_cents) || (revenue - expense);

  const marginPct =
    row.margin_pct != null
      ? Number(row.margin_pct)
      : revenue > 0
        ? Math.round((profit / revenue) * 1000) / 10
        : null;

  const jobLabel =
    label || row.job_name || (row.job_no != null ? `Job #${row.job_no}` : 'That job');

  return [
    `📌 ${jobLabel}`,
    ``,
    `Revenue: ${money(revenue)}`,
    `Spend: ${money(expense)}`,
    `Profit: ${money(profit)}${marginPct != null ? ` (${pct(marginPct)})` : ``}`
  ].join('\n');
}

async function answerProfitIntent({ ownerId, actorKey, text }) {
  const resolved = await resolveJobForProfit({ ownerId, actorKey, text });

  // Ambiguous fragment
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

  // Deterministic answer if we have a job_no
  if (Number.isFinite(resolved.jobNo)) {
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

    return {
      ok: true,
      route: 'clarify',
      answer: `I couldn’t find Job #${resolved.jobNo}. Try “list jobs” or tell me the job name.`,
      evidence: { sql: [], facts_used: 0 }
    };
  }

  // If they provided a term but it didn't resolve
  // (ex: "oak st" but no matching job found)
  if (resolved?.source === 'not_found' || resolved?.source === 'none') {
    return {
      ok: true,
      route: 'clarify',
      answer: `I couldn’t match that to a job. Try “list jobs”, or say something like “profit on Oak Street Re-roof”.`,
      evidence: { sql: [], facts_used: 0 }
    };
  }

  return {
    ok: true,
    route: 'clarify',
    answer: `Which job are you asking about? Reply like “profit on job 18” or “profit on active job”.`,
    evidence: { sql: [], facts_used: 0 }
  };
}

function looksLikeProfitQuestion(text) {
  const s = lc(String(text || '').replace(/\s+/g, ' ').trim());

  const hasProfitIntent =
    /\bprofit\b|\bmargin\b|\bhow much am i making\b|\bhow much are we making\b|\bwhat am i making\b|\bmaking\b/.test(s);

  // allow: "on oak st", "profit 1556", "profit on 1556"
  const hasJobAnchor =
    /\bjob\b|(^|\s)#\d+\b|\bactive job\b|\bon\s+[a-z0-9]/.test(s) || /\bprofit\s+\d+/.test(s);

  return hasProfitIntent && hasJobAnchor;
}

async function answerInsightV0({ ownerId, actorKey, text, tz }) {
  const raw = String(text || '').trim();
  const s = lc(raw);

  // 1) Job profit / margin
  if (looksLikeProfitQuestion(raw)) {
    return await answerProfitIntent({ ownerId, actorKey, text: raw });
  }

  // 2) Spend / revenue totals (Phase 1)
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
      return {
        ok: true,
        route: 'insight',
        answer: `Spend for today ${money(cents)}`,
        evidence: { sql: ['getTotalsForRange(today)'], facts_used: 1 }
      };
    }
  }

  return {
    ok: true,
    route: 'clarify',
    answer: `Try: “spend today” or “profit on Oak Street Re-roof”.`,
    evidence: { sql: [], facts_used: 0 }
  };
}

module.exports = { answerInsightV0 };
