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
      if (token && !/^job\b/i.test(token)) {
        const jobNo = /^\d+$/.test(token) ? Number(token) : null;
        // NOTE: keep name as token for downstream resolution; we'll treat digits-only
        // as a name-anchor (address) rather than job_no.
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

/**
 * Decide if a numeric token should be treated as:
 * - a "job_no" (internal numbering like 1,2,3...) OR
 * - an address-style anchor like 1556 (house #)
 *
 * Your observed bug (1556 -> 1559) strongly suggests:
 * - job_no is NOT 1556
 * - 1556 lives in the job NAME, not job_no
 *
 * So: treat 4+ digits as an address/name-anchor by default.
 */
function isLikelyAddressNumber(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return false;
  // Heuristic: 4+ digit numbers are almost always address numbers in your UX.
  return x >= 1000;
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolve job by:
// 1) exact job_no ONLY when jobNo looks like internal numbering (not address numbers like 1556)
// 2) exact name (case-insensitive)
// 3) fragment search:
//    - digits-only term (e.g., "1556") => MUST match job name starting with that number (word boundary)
//    - otherwise => ILIKE %term%, with ranking
async function resolveJobForInsight(pgClient, ownerId, ref) {
  const owner = String(ownerId || '').trim();
  if (!owner) return { ok: false, reason: 'missing_owner' };

  const jobNo =
    ref?.jobNo != null && Number.isFinite(Number(ref.jobNo)) ? Number(ref.jobNo) : null;

  const name = ref?.name ? String(ref.name).trim() : null;

  const hasNumeric = jobNo != null;
  const numericLooksAddress = hasNumeric && isLikelyAddressNumber(jobNo);

  // 1) Try job_no direct ONLY if it's likely internal numbering
  if (jobNo != null && !numericLooksAddress) {
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
  // (Skip exact-name match when name is digits-only; that’s handled by numeric-anchor search below.)
  if (name && !/^\d+$/.test(name)) {
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

  // 3) Fragment fallback (numeric-safe)
  const term = (name || (jobNo != null ? String(jobNo) : '')).trim();
  if (term) {
    const termIsDigits = /^\d{1,10}$/.test(term);

    // ✅ Special: digits-only term (like "1556") => match name that STARTS with "1556" (word boundary)
    if (termIsDigits) {
      try {
        const re = `^${escapeRegex(term)}\\b`; // e.g. ^1556\b

        const r = await pgClient.query(
          `
          select id, job_no, coalesce(name, job_name) as job_name, active, status
          from public.jobs
          where owner_id::text = $1
            and lower(coalesce(name, job_name)) ~ lower($2)
          order by
            active desc nulls last,
            updated_at desc nulls last,
            created_at desc
          limit 5
          `,
          [owner, re]
        );

        const rows = r?.rows || [];
        if (rows.length === 1) return { ok: true, job: rows[0], mode: 'name_startswith_digits' };
        if (rows.length > 1) return { ok: false, reason: 'ambiguous', matches: rows, term };
        // If none start with the number, treat as not_found (do not guess)
      } catch {}
      return { ok: false, reason: 'not_found' };
    }

    // ✅ Default: non-numeric term => contains search + ranking
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
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const s = raw.toLowerCase();

  const explicitActive = /\bactive\s+job\b/.test(s);
  const ref = extractJobRefFromText(raw);

  const explicitRefProvided = !!(
    ref &&
    (ref.jobNo != null || (ref.name && String(ref.name).trim()) || (ref.raw && String(ref.raw).trim()))
  );

  // Resolve via DB (job_no / exact name / contains)
  const resolved = await resolveJobForInsight(pg, ownerId, ref);

  if (resolved?.ok && resolved?.job) {
    const out = {
      jobNo: Number(resolved.job.job_no),
      jobName: resolved.job.job_name || null,
      source: resolved.mode || 'resolved'
    };

    // ✅ HARD MISMATCH BLOCK:
    // If the user referenced a digits-only anchor (e.g., "1556") and we resolved a job whose
    // NAME does not start with that anchor, do NOT answer (prevents 1556 -> 1559 forever).
    const requestedDigits =
      ref && (typeof ref.name === 'string' && /^\d{4,10}$/.test(ref.name.trim()))
        ? ref.name.trim()
        : (ref && ref.jobNo != null && isLikelyAddressNumber(ref.jobNo) ? String(ref.jobNo) : null);

    if (requestedDigits) {
      const jn = String(out.jobName || '').trim();
      const startsOk = new RegExp(`^${escapeRegex(requestedDigits)}\\b`, 'i').test(jn);
      if (!startsOk) {
        return {
          jobNo: null,
          jobName: null,
          source: 'not_found_explicit',
          term: requestedDigits
        };
      }
    }

    return out;
  }

  // Ambiguous matches
  if (resolved?.reason === 'ambiguous') {
    return {
      jobNo: null,
      jobName: null,
      source: 'ambiguous',
      matches: resolved.matches || [],
      term: resolved.term || ref?.raw || ref?.name || ''
    };
  }

  // ✅ CRITICAL:
  // If the user explicitly referenced a job, DO NOT silently fall back to active job.
  if (explicitRefProvided && !explicitActive) {
    return {
      jobNo: null,
      jobName: null,
      source: 'not_found_explicit',
      term: String(ref?.raw || ref?.name || ref?.jobNo || '').trim()
    };
  }

  // Only fall back to active job when:
  // - user explicitly asked for active job, OR
  // - user did not provide any job ref at all
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

  // ✅ If they asked for a specific job and we couldn't find it, never answer active job.
  if (resolved?.source === 'not_found_explicit') {
    const term = String(resolved.term || '').trim();
    return {
      ok: true,
      route: 'clarify',
      answer:
        `I couldn’t find a job matching "${term}".\n\n` +
        `Try:\n` +
        `• “list jobs”\n` +
        `• “profit on 1556”\n` +
        `• “profit on Oak Street Re-roof”\n` +
        `• “profit on active job”`,
      evidence: { sql: [], facts_used: 0 }
    };
  }

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

  // Final fallback (no explicit job ref and no active job)
  return {
    ok: true,
    route: 'clarify',
    answer: `Which job are you asking about? Reply like “profit on 1556”, “profit on Oak Street”, or “profit on active job”.`,
    evidence: { sql: [], facts_used: 0 }
  };
}

function looksLikeProfitQuestion(text) {
  const s = lc(String(text || '').replace(/\s+/g, ' ').trim());

  const hasProfitIntent =
    /\bprofit\b|\bmargin\b|\bhow much am i making\b|\bhow much are we making\b|\bwhat am i making\b|\bmaking\b/.test(s);

  const hasJobAnchor =
    /\bjob\b|(^|\s)#\d+\b|\bactive job\b|\bon\s+[a-z0-9]/.test(s) || /\bprofit\s+\d+/.test(s);

  return hasProfitIntent && hasJobAnchor;
}

function ymdInTZ(tz = 'America/Toronto') {
  try {
    if (typeof pg.todayInTZ === 'function') return pg.todayInTZ(tz);
  } catch {}
  return new Date().toISOString().slice(0, 10);
}

function dateShift(ymd, deltaDays) {
  const s = String(ymd || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;

  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);

  const dt = new Date(Date.UTC(y, mo, d));
  dt.setUTCDate(dt.getUTCDate() + Number(deltaDays || 0));
  return dt.toISOString().slice(0, 10);
}

async function answerInsightV0({ ownerId, actorKey, text, tz }) {
  const raw = String(text || '').trim();
  const s = lc(raw);

  // 1) Job profit / margin
  if (looksLikeProfitQuestion(raw)) {
    return await answerProfitIntent({ ownerId, actorKey, text: raw });
  }

  // 2) Business totals
  const wantsSpend = /\bspend\b|\bspent\b|\bexpenses?\b/.test(s);
  const wantsRevenue = /\brevenue\b|\bsales\b|\bearned\b/.test(s);
  const wantsProfit = /\bprofit\b|\bmargin\b|\bnet\b/.test(s);

  const wantsToday = /\btoday\b/.test(s);
  const wants7 = /\blast\s*7\s*days\b|\bpast\s*7\s*days\b/.test(s);
  const wants30 = /\blast\s*30\s*days\b|\bpast\s*30\s*days\b/.test(s);

  if ((wantsSpend || wantsRevenue || wantsProfit) && (wantsToday || wants7 || wants30)) {
    const tzUse = String(tz || '').trim() || 'America/Toronto';
    const toIso = ymdInTZ(tzUse);

    let fromIso = toIso;
    if (wants30) fromIso = dateShift(toIso, -29);
    else if (wants7) fromIso = dateShift(toIso, -6);
    if (!fromIso) fromIso = toIso;

    const spendCents = await pg.sumExpensesCentsByRange({ ownerId, fromIso, toIso });
    const revenueCents = await pg.sumRevenueCentsByRange({ ownerId, fromIso, toIso });
    const profitCents = Number(revenueCents || 0) - Number(spendCents || 0);

    const label = wantsToday ? 'today' : wants30 ? 'last 30 days' : 'last 7 days';

    const lines = [`For ${label}:`];
    if (wantsRevenue) lines.push(`• Revenue: ${money(revenueCents)}`);
    if (wantsSpend) lines.push(`• Spend: ${money(spendCents)}`);
    if (wantsProfit) lines.push(`• Profit (revenue − spend): ${money(profitCents)}`);

    return {
      ok: true,
      route: 'insight',
      answer: lines.join('\n'),
      evidence: { sql: ['sumExpensesCentsByRange', 'sumRevenueCentsByRange'], facts_used: 2 }
    };
  }

  // 3) Legacy fallback (optional)
  if (typeof pg.getTotalsForRange === 'function') {
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
    answer: `Try: “spend today”, “revenue last 7 days”, or “profit on Oak Street Re-roof”.`,
    evidence: { sql: [], facts_used: 0 }
  };
}

module.exports = { answerInsightV0 };
