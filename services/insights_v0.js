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
    .replace(/\u00A0/g, ' ')      // NBSP -> space
    .replace(/\s+/g, ' ')
    .replace(/^job\s+/i, '')
    .replace(/^#\s*/i, '')
    .trim();
}

// We ONLY treat a number as job_no when the user uses an explicit job-no cue:
//   "job 12", "job #12", "#12"
function hasJobNoCue(rawText = '') {
  const t = String(rawText || '').replace(/\u00A0/g, ' ').trim();
  return (
    /\bjob\s*#?\s*\d+\b/i.test(t) ||
    /(^|\s)#\s*\d+\b/i.test(t)
  );
}

// If the token is numeric-only (e.g. "1556"), it is almost certainly an address/job-name anchor in your system.
// (Your job_no values are small sequential ints.)
function isNumericOnlyToken(token) {
  return /^\d{1,10}$/.test(String(token || '').trim());
}

// Pull job ref out of phrases like:
// - "profit on job 12"
// - "profit on #12"
// - "profit on 1556"
// - "profit 1556 medway"
// - "how much am i making on oak street"
function extractJobRefFromText(rawText) {
  const t = String(rawText || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const s = t.toLowerCase();

  const isProfitIntent =
    /\bprofit\b|\bmargin\b|\bhow much am i making\b|\bhow much are we making\b|\bwhat am i making\b|\bmaking\b/i.test(s);

  if (!isProfitIntent) return { kind: null, jobNo: null, name: null, raw: null };

  // 1) Explicit internal job number cue:
  // - "#12" or "job #12" => ALWAYS job_no
  {
    const m =
      t.match(/(^|\s)#\s*(\d{1,10})\b/i) ||
      t.match(/\bjob\s*#\s*(\d{1,10})\b/i);

    if (m) {
      const num = m[2] || m[1];
      const jobNo = Number(num);
      if (Number.isFinite(jobNo)) {
        return { kind: 'job_no', jobNo, name: null, raw: `job #${jobNo}` };
      }
    }
  }

  // 2) "job 12" (no #) — treat as job_no ONLY for "small" numbers.
  // If it's 4+ digits (1556), it's almost certainly an address-style anchor in your system.
  {
    const m = t.match(/\bjob\s+(\d{1,10})\b/i);
    if (m) {
      const numStr = String(m[1] || '').trim();
      const n = Number(numStr);

      if (Number.isFinite(n)) {
        if (numStr.length >= 4) {
          // "job 1556" => address/name anchor, NOT job_no
          return { kind: 'name', jobNo: null, name: numStr, raw: numStr };
        }
        // "job 12" => internal job_no
        return { kind: 'job_no', jobNo: n, name: null, raw: `job ${n}` };
      }
    }
  }

  // 3) "on <term>" (name/address anchor)
  {
    const m = t.match(/\bon\b\s+([\s\S]+)$/i);
    if (m) {
      const token = normalizeJobRefToken(m[1] || '');
      if (token) {
        return { kind: 'name', jobNo: null, name: token, raw: token };
      }
    }
  }

  // 4) "profit <term>" / "margin <term>"
  {
    const m = t.match(/^\s*(?:profit|margin)\s+([\s\S]+)$/i);
    if (m) {
      const token = normalizeJobRefToken(m[1] || '');
      if (token) {
        return { kind: 'name', jobNo: null, name: token, raw: token };
      }
    }
  }

  return { kind: null, jobNo: null, name: null, raw: null };
}


/**
 * Resolve job by:
 * 1) job_no ONLY if ref.kind === 'job_no'
 * 2) exact name match (normalized) if name provided
 * 3) name fragment fallback:
 *    - if term begins with digits (e.g. "1556", "1556 medway") => REQUIRE starts_with those digits
 *    - otherwise => contains match, ranked by starts-with, then active, then recency
 */
async function resolveJobForInsight(pgClient, ownerId, ref) {
  const owner = String(ownerId || '').trim();
  if (!owner) return { ok: false, reason: 'missing_owner' };

  const kind = ref?.kind || null;
  const jobNo =
    kind === 'job_no' && ref?.jobNo != null && Number.isFinite(Number(ref.jobNo))
      ? Number(ref.jobNo)
      : null;

  const name = ref?.name ? String(ref.name).trim() : null;

  // Normalization helpers (SQL-side):
  // - coalesce(name, job_name)
  // - replace NBSP with space
  // - collapse whitespace
  // - lowercase
  const SQL_NORM = `lower(regexp_replace(replace(coalesce(name, job_name), chr(160), ' '), '\\s+', ' ', 'g'))`;

  // 1) job_no direct (ONLY when explicitly requested)
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

  // If no name, we can't do name resolution.
  if (!name) return { ok: false, reason: 'not_found' };

  const term = normalizeJobRefToken(name);
  if (!term) return { ok: false, reason: 'not_found' };

  const termNorm = normalizeJobRefToken(term).toLowerCase();
  const digitsPrefix = (termNorm.match(/^(\d{2,10})\b/) || [])[1] || null; // 2+ digits only

  // 2) exact name match (normalized)
  try {
    const r = await pgClient.query(
      `
      select id, job_no, coalesce(name, job_name) as job_name
      from public.jobs
      where owner_id::text = $1
        and ${SQL_NORM} = lower($2)
      order by updated_at desc nulls last, created_at desc
      limit 1
      `,
      [owner, termNorm]
    );
    if (r?.rows?.[0]) return { ok: true, job: r.rows[0], mode: 'exact_name' };
  } catch {}

  // 3a) If the term starts with digits (like your addresses), REQUIRE starts-with those digits.
  // This prevents 1556 -> 1559 accidental picks forever.
  if (digitsPrefix) {
    try {
      const r = await pgClient.query(
        `
        select id, job_no, coalesce(name, job_name) as job_name, active, status
        from public.jobs
        where owner_id::text = $1
          and ${SQL_NORM} like lower($2)
        order by
          active desc nulls last,
          updated_at desc nulls last,
          created_at desc
        limit 5
        `,
        [owner, `${digitsPrefix}%`]
      );

      const rows = r?.rows || [];
      if (rows.length === 1) return { ok: true, job: rows[0], mode: 'digits_starts_with' };
      if (rows.length > 1) return { ok: false, reason: 'ambiguous', matches: rows, term: digitsPrefix };
    } catch {}

    // If digits-prefix match found nothing, do NOT fall back to fuzzy contains.
    // That's how 1556 can accidentally become 1559.
    return { ok: false, reason: 'not_found', term: digitsPrefix };
  }

  // 3b) Otherwise do contains match with ranking.
  try {
    const r = await pgClient.query(
      `
      select id, job_no, coalesce(name, job_name) as job_name, active, status
      from public.jobs
      where owner_id::text = $1
        and ${SQL_NORM} like lower($2)
      order by
        case
          when ${SQL_NORM} like lower($3) then 0
          else 1
        end,
        active desc nulls last,
        updated_at desc nulls last,
        created_at desc
      limit 5
      `,
      [owner, `%${termNorm}%`, `${termNorm}%`]
    );

    const rows = r?.rows || [];
    if (rows.length === 1) return { ok: true, job: rows[0], mode: 'name_contains' };
    if (rows.length > 1) return { ok: false, reason: 'ambiguous', matches: rows, term: termNorm };
  } catch {}

  return { ok: false, reason: 'not_found', term: termNorm };
}

async function resolveJobForProfit({ ownerId, actorKey, text }) {
  const raw = String(text || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  const s = raw.toLowerCase();

  const explicitActive = /\bactive\s+job\b/.test(s);
  const ref = extractJobRefFromText(raw);

  const explicitRefProvided = !!(
    ref &&
    (ref.kind === 'job_no' ||
      (ref.name && String(ref.name).trim()) ||
      (ref.raw && String(ref.raw).trim()))
  );

  // Resolve via DB (job_no only if explicitly requested; else name/address)
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
      term: resolved.term || ref?.raw || ref?.name || ''
    };
  }

  // ✅ CRITICAL:
  // If user explicitly referenced a job (1556 / oak street / job #12) and we can't resolve it,
  // DO NOT fall back to active job.
  if (explicitRefProvided && !explicitActive) {
    return {
      jobNo: null,
      jobName: null,
      source: 'not_found_explicit',
      term: String(resolved?.term || ref?.raw || ref?.name || ref?.jobNo || '').trim()
    };
  }

  // Only fall back to active job if they explicitly asked for it, or gave no ref at all.
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
  const jn = Number(jobNo);
  if (!Number.isFinite(jn)) return null; // hard stop

  if (typeof pg.getJobProfitSimple === 'function') {
    const r = await pg.getJobProfitSimple({ ownerId, jobNo: jn, limit: 1 });
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

  // Helpful debug: what did we resolve to?
  console.info('[INSIGHTS_PROFIT_RESOLVED]', {
    ownerId,
    text: String(text || '').slice(0, 80),
    source: resolved?.source || null,
    jobNo: resolved?.jobNo ?? null,
    jobName: resolved?.jobName ?? null
  });

  // If they asked for a specific job and we couldn't find it, never answer active job.
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
  if (Number.isFinite(Number(resolved?.jobNo))) {
    const requestedJobNo = Number(resolved.jobNo);
    const row = await getProfitRowByJobNo(ownerId, requestedJobNo);

    if (row) {
      // ✅ SAFETY GUARD #1: job_no must match
      const rowJobNo = row.job_no != null ? Number(row.job_no) : null;
      if (rowJobNo == null || rowJobNo !== requestedJobNo) {
        console.warn('[INSIGHTS_PROFIT_MISMATCH_JOBNO]', {
          ownerId,
          requestedJobNo,
          requestedJobName: resolved.jobName || null,
          returnedRowJobNo: rowJobNo,
          returnedRowJobName: row.job_name || null
        });

        return {
          ok: true,
          route: 'clarify',
          answer:
            `I hit a mismatch while calculating profit (requested Job #${requestedJobNo}, but profit data returned for ` +
            `${rowJobNo != null ? `Job #${rowJobNo}` : 'a different job'}).\n\n` +
            `Try:\n• “profit on job #${requestedJobNo}”\n• “list jobs”`,
          evidence: { sql: ['v_job_profit_simple_fixed/getJobProfitSimple'], facts_used: 0 }
        };
      }

      // ✅ SAFETY GUARD #2: if user typed an address-style prefix (e.g. "1556"),
      // ensure returned job_name starts with that prefix. This catches corrupted profit rows
      // where job_no matches but job_name is wrong.
      const raw = String(text || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
      const m = raw.match(/\bprofit\b[\s\S]*?\bon\s+(\d{2,10})\b/i) || raw.match(/^\s*profit\s+(\d{2,10})\b/i);
      const requestedDigits = m ? String(m[1] || '').trim() : null;

      if (requestedDigits) {
        const nameHead = String(row.job_name || '').replace(/\u00A0/g, ' ').trim();
        const startsOk = new RegExp(`^${requestedDigits}\\b`, 'i').test(nameHead);
        if (!startsOk) {
          console.warn('[INSIGHTS_PROFIT_MISMATCH_NAMEPREFIX]', {
            ownerId,
            requestedJobNo,
            requestedDigits,
            returnedRowJobName: row.job_name || null
          });

          return {
            ok: true,
            route: 'clarify',
            answer:
              `Your profit data looks inconsistent for Job #${requestedJobNo} (it returned “${String(row.job_name || '').trim()}”).\n\n` +
              `Try:\n• “profit on job #${requestedJobNo}”\n• “list jobs”`,
            evidence: { sql: ['v_job_profit_simple_fixed/getJobProfitSimple'], facts_used: 0 }
          };
        }
      }

      return {
        ok: true,
        route: 'insight',
        answer: profitReply({
          row,
          label: row.job_name || resolved.jobName || `Job #${requestedJobNo}`
        }),
        evidence: { sql: ['v_job_profit_simple_fixed/getJobProfitSimple'], facts_used: 4 }
      };
    }

    return {
      ok: true,
      route: 'clarify',
      answer: `I couldn’t find Job #${requestedJobNo}. Try “list jobs” or tell me the job name.`,
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
  const s = lc(String(text || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim());

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
