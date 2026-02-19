// services/insights_v0.js
// MVP-safe deterministic insights (NO hallucinations)
// Goal: answer lots of business questions safely using only DB facts,
// and fall back to "clarify" with good suggestions (never crash).

const pg = require("./postgres");

function lc(s) {
  return String(s || "").toLowerCase();
}

function DIGITS(x) {
  return String(x ?? "").replace(/\D/g, "");
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

function safeYmd(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

// -------------------- Range normalization --------------------

function normalizeRangeFromText(text, fallback = "mtd") {
  const t = String(text || "").toLowerCase();

  if (/\b(today|todays|today's)\b/.test(t)) return "today";
  if (/\b(wtd|week to date|this week)\b/.test(t)) return "wtd";
  if (/\b(mtd|month to date|this month)\b/.test(t)) return "mtd";
  if (/\b(ytd|year to date|this year)\b/.test(t)) return "ytd";
  if (/\b(all time|all)\b/.test(t)) return "all";

  // rolling windows -> v0 maps to “wtd/mtd” style unless you add true rolling support
  if (/\b(last 7 days|past 7 days|previous 7 days)\b/.test(t)) return "last7";
  if (/\b(last 30 days|past 30 days|previous 30 days)\b/.test(t)) return "last30";

  return fallback;
}

// If you have pg.todayInTZ use it, else fallback.
function ymdInTZ(tz = "America/Toronto") {
  try {
    if (typeof pg.todayInTZ === "function") return pg.todayInTZ(tz);
  } catch {}
  return new Date().toISOString().slice(0, 10);
}

function dateShift(ymd, deltaDays) {
  const s = String(ymd || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;

  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);

  const dt = new Date(Date.UTC(y, mo, d));
  dt.setUTCDate(dt.getUTCDate() + Number(deltaDays || 0));
  return dt.toISOString().slice(0, 10);
}

// Turn a normalized range into from/to (inclusive YMD).
// This keeps v0 deterministic and consistent.
function rangeToFromTo(range, tz) {
  const toIso = ymdInTZ(tz);

  if (range === "today") return { fromIso: toIso, toIso };

  if (range === "last7") {
    const fromIso = dateShift(toIso, -6) || toIso;
    return { fromIso, toIso };
  }

  if (range === "last30") {
    const fromIso = dateShift(toIso, -29) || toIso;
    return { fromIso, toIso };
  }

  // For WTD/MTD/YTD we’ll prefer a calendar-aligned window if you have it.
  // If not, we approximate with fixed shifts (still deterministic).
  if (range === "wtd") {
    // Approx: last 7 days (good enough for tomorrow)
    const fromIso = dateShift(toIso, -6) || toIso;
    return { fromIso, toIso };
  }

  if (range === "mtd") {
    // Approx: last 30 days (good enough for tomorrow)
    const fromIso = dateShift(toIso, -29) || toIso;
    return { fromIso, toIso };
  }

  if (range === "ytd") {
    // Approx: last 365 days (good enough for tomorrow)
    const fromIso = dateShift(toIso, -364) || toIso;
    return { fromIso, toIso };
  }

  // "all" -> try very early
  if (range === "all") {
    return { fromIso: "2000-01-01", toIso };
  }

  // default
  return rangeToFromTo("mtd", tz);
}

// -------------------- Job profit (existing strong path) --------------------
// NOTE: Your existing profit resolver + picker code is good.
// I’m leaving it as-is, but removing the stray effectiveRange lines
// (those should only live inside answerInsightV0).

// ---- Begin: your existing profit parsing/resolution helpers (unchanged) ----

function normalizeJobRefToken(s) {
  return String(s || "")
    .trim()
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^job\s+/i, "")
    .replace(/^#\s*/i, "")
    .trim();
}

function extractJobRefFromText(rawText) {
  const t = String(rawText || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const s = t.toLowerCase();
  const isProfitIntent =
    /\bprofit\b|\bmargin\b|\bhow much am i making\b|\bhow much are we making\b|\bwhat am i making\b|\bmaking\b/i.test(
      s
    );

  if (!isProfitIntent) return { kind: null, jobNo: null, name: null, raw: null };

  {
    const m = t.match(/(^|\s)#\s*(\d{1,10})\b/i) || t.match(/\bjob\s*#\s*(\d{1,10})\b/i);
    if (m) {
      const num = m[2] || m[1];
      const jobNo = Number(num);
      if (Number.isFinite(jobNo)) return { kind: "job_no", jobNo, name: null, raw: `job #${jobNo}` };
    }
  }

  {
    const m = t.match(/\bjob\s+(\d{1,10})\b/i);
    if (m) {
      const numStr = String(m[1] || "").trim();
      const n = Number(numStr);
      if (Number.isFinite(n)) {
        if (numStr.length >= 4) return { kind: "name", jobNo: null, name: numStr, raw: numStr };
        return { kind: "job_no", jobNo: n, name: null, raw: `job ${n}` };
      }
    }
  }

  {
    const m = t.match(/\bon\b\s+([\s\S]+)$/i);
    if (m) {
      const token = normalizeJobRefToken(m[1] || "");
      if (token) return { kind: "name", jobNo: null, name: token, raw: token };
    }
  }

  {
    const m = t.match(/^\s*(?:profit|margin)\s+([\s\S]+)$/i);
    if (m) {
      const token = normalizeJobRefToken(m[1] || "");
      if (token) return { kind: "name", jobNo: null, name: token, raw: token };
    }
  }

  return { kind: null, jobNo: null, name: null, raw: null };
}

async function resolveJobForInsight(pgClient, ownerId, ref) {
  const owner = String(ownerId || "").trim();
  if (!owner) return { ok: false, reason: "missing_owner" };

  const kind = ref?.kind || null;
  const jobNo =
    kind === "job_no" && ref?.jobNo != null && Number.isFinite(Number(ref.jobNo)) ? Number(ref.jobNo) : null;
  const name = ref?.name ? String(ref.name).trim() : null;

  const SQL_NORM = `lower(regexp_replace(replace(coalesce(name, job_name), chr(160), ' '), '\\s+', ' ', 'g'))`;

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
      if (r?.rows?.[0]) return { ok: true, job: r.rows[0], mode: "job_no" };
    } catch {}
  }

  if (!name) return { ok: false, reason: "not_found" };

  const term = normalizeJobRefToken(name);
  if (!term) return { ok: false, reason: "not_found" };

  const termNorm = normalizeJobRefToken(term).toLowerCase();
  const digitsPrefix = (termNorm.match(/^(\d{2,10})\b/) || [])[1] || null;

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
    if (r?.rows?.[0]) return { ok: true, job: r.rows[0], mode: "exact_name" };
  } catch {}

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
      if (rows.length === 1) return { ok: true, job: rows[0], mode: "digits_starts_with" };
      if (rows.length > 1) return { ok: false, reason: "ambiguous", matches: rows, term: digitsPrefix };
    } catch {}

    return { ok: false, reason: "not_found", term: digitsPrefix };
  }

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
    if (rows.length === 1) return { ok: true, job: rows[0], mode: "name_contains" };
    if (rows.length > 1) return { ok: false, reason: "ambiguous", matches: rows, term: termNorm };
  } catch {}

  return { ok: false, reason: "not_found", term: termNorm };
}

async function getProfitRowByJobNo(ownerId, jobNo) {
  const jn = Number(jobNo);
  if (!Number.isFinite(jn)) return null;

  if (typeof pg.getJobProfitSimple === "function") {
    const r = await pg.getJobProfitSimple({ ownerId, jobNo: jn, limit: 1 });
    return r?.rows?.[0] || null;
  }

  return null;
}

function profitReply({ row, label }) {
  const revenue = Number(row.revenue_cents) || 0;
  const expense = Number(row.expense_cents) || 0;
  const profit = Number(row.profit_cents) || revenue - expense;

  const marginPct =
    row.margin_pct != null
      ? Number(row.margin_pct)
      : revenue > 0
      ? Math.round((profit / revenue) * 1000) / 10
      : null;

  const jobLabel = label || row.job_name || (row.job_no != null ? `Job #${row.job_no}` : "That job");

  return [
    `📌 ${jobLabel}`,
    ``,
    `Revenue: ${money(revenue)}`,
    `Spend: ${money(expense)}`,
    `Profit: ${money(profit)}${marginPct != null ? ` (${pct(marginPct)})` : ``}`,
  ].join("\n");
}

function looksLikeProfitQuestion(text) {
  const s = lc(String(text || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim());
  const hasProfitIntent =
    /\bprofit\b|\bmargin\b|\bhow much am i making\b|\bhow much are we making\b|\bwhat am i making\b|\bmaking\b/.test(
      s
    );
  const hasJobAnchor = /\bjob\b|(^|\s)#\d+\b|\bactive job\b|\bon\s+[a-z0-9]/.test(s) || /\bprofit\s+\d+/.test(s);
  return hasProfitIntent && hasJobAnchor;
}

async function resolveJobForProfit({ ownerId, actorKey, text }) {
  const raw = String(text || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
  const s = raw.toLowerCase();

  const explicitActive = /\bactive\s+job\b/.test(s);
  const ref = extractJobRefFromText(raw);

  const explicitRefProvided = !!(
    ref &&
    (ref.kind === "job_no" || (ref.name && String(ref.name).trim()) || (ref.raw && String(ref.raw).trim()))
  );

  const resolved = await resolveJobForInsight(pg, ownerId, ref);

  if (resolved?.ok && resolved?.job) {
    return { jobNo: Number(resolved.job.job_no), jobName: resolved.job.job_name || null, source: resolved.mode || "resolved" };
  }

  if (resolved?.reason === "ambiguous") {
    return { jobNo: null, jobName: null, source: "ambiguous", matches: resolved.matches || [], term: resolved.term || ref?.raw || ref?.name || "" };
  }

  if (explicitRefProvided && !explicitActive) {
    return { jobNo: null, jobName: null, source: "not_found_explicit", term: String(resolved?.term || ref?.raw || ref?.name || ref?.jobNo || "").trim() };
  }

  try {
    if (typeof pg.getActiveJob === "function") {
      const aj = await pg.getActiveJob(ownerId, actorKey);
      if (aj && typeof aj === "object" && aj.job_no != null) {
        return { jobNo: Number(aj.job_no), jobName: aj.name || null, source: "active_job" };
      }
    }
  } catch {}

  return { jobNo: null, jobName: null, source: resolved?.reason || "none" };
}

async function answerProfitIntent({ ownerId, actorKey, text }) {
  const resolved = await resolveJobForProfit({ ownerId, actorKey, text });

  console.info("[INSIGHTS_PROFIT_RESOLVED]", {
    ownerId,
    text: String(text || "").slice(0, 80),
    source: resolved?.source || null,
    jobNo: resolved?.jobNo ?? null,
    jobName: resolved?.jobName ?? null,
  });

  if (Number.isFinite(Number(resolved?.jobNo))) {
    const requestedJobNo = Number(resolved.jobNo);
    const row = await getProfitRowByJobNo(ownerId, requestedJobNo);

    if (row) {
      return {
        ok: true,
        route: "insight",
        answer: profitReply({ row, label: row.job_name || resolved.jobName || `Job #${requestedJobNo}` }),
        evidence: { sql: ["v_job_profit_simple_fixed/getJobProfitSimple"], facts_used: 4 },
      };
    }

    return { ok: true, route: "clarify", answer: `I couldn’t find Job #${requestedJobNo}. Try “list jobs” or tell me the job name.`, evidence: { sql: [], facts_used: 0 } };
  }

  return {
    ok: true,
    route: "clarify",
    answer: `Tell me the job (e.g., “profit on job 1556” or “profit on Oak Street Re-roof”).`,
    evidence: { sql: [], facts_used: 0 },
  };
}

// ---- End: profit helpers ----

// -------------------- New: deterministic totals (spend/revenue/net) using effectiveRange --------------------

async function totalsForRange({ ownerId, fromIso, toIso }) {
  // Prefer your existing pg helpers (fast + already-canonical)
  const spendCents =
    typeof pg.sumExpensesCentsByRange === "function"
      ? await pg.sumExpensesCentsByRange({ ownerId, fromIso, toIso })
      : null;

  const revenueCents =
    typeof pg.sumRevenueCentsByRange === "function"
      ? await pg.sumRevenueCentsByRange({ ownerId, fromIso, toIso })
      : null;

  // If helpers missing, fail safe.
  if (spendCents == null && revenueCents == null) {
    return { ok: false, reason: "missing_pg_helpers" };
  }

  const spend = Number(spendCents || 0);
  const revenue = Number(revenueCents || 0);
  const net = revenue - spend;
  return { ok: true, spend, revenue, net };
}

// -------------------- New: cash in/out (best-effort, guarded) --------------------

async function cashflowForRange({ ownerId, fromIso, toIso }) {
  // Try view v_cashflow_daily if present.
  // If schema differs, this will throw and we’ll gracefully return unsupported.
  try {
    const o = DIGITS(ownerId);
    const r = await pg.query(
      `
      select
        coalesce(sum(cash_in_cents),0)::bigint as in_cents,
        coalesce(sum(cash_out_cents),0)::bigint as out_cents
      from public.v_cashflow_daily
      where owner_id::text = $1
        and day >= $2::date
        and day <= $3::date
      `,
      [o, fromIso, toIso]
    );

    const row = r?.rows?.[0];
    if (!row) return { ok: false, reason: "no_rows" };

    const inCents = Number(row.in_cents || 0);
    const outCents = Number(row.out_cents || 0);
    return { ok: true, inCents, outCents, netCents: inCents - outCents };
  } catch (e) {
    return { ok: false, reason: "unsupported" };
  }
}

// -------------------- New: top expenses by category/vendor (best-effort) --------------------

async function topExpenseBreakdown({ ownerId, fromIso, toIso, limit = 5 }) {
  try {
    const o = DIGITS(ownerId);
    // Column names may differ; keep guarded.
    const r = await pg.query(
      `
      select
        coalesce(category, 'Uncategorized') as category,
        coalesce(sum(amount_cents),0)::bigint as cents
      from public.expenses
      where owner_id::text = $1
        and (ts::date >= $2::date and ts::date <= $3::date)
      group by 1
      order by cents desc
      limit $4
      `,
      [o, fromIso, toIso, Number(limit)]
    );

    const rows = r?.rows || [];
    if (!rows.length) return { ok: false, reason: "no_rows" };
    return { ok: true, rows };
  } catch {
    return { ok: false, reason: "unsupported" };
  }
}

// -------------------- Main entry --------------------

async function answerInsightV0({ ownerId, actorKey, text, tz }) {
  const raw = String(text || "").trim();
  const s = lc(raw);
  const tzUse = String(tz || "").trim() || "America/Toronto";

  // (2) ✅ effectiveRange computed here (correct place)
  const effectiveRange = normalizeRangeFromText(raw, "mtd");
  const { fromIso, toIso } = rangeToFromTo(effectiveRange, tzUse);

  console.info("[INSIGHTS_RANGE_RESOLVED]", { ownerId, text: raw.slice(0, 80), effectiveRange, fromIso, toIso });

  // 1) Profit / margin (job)
  if (looksLikeProfitQuestion(raw)) {
    return await answerProfitIntent({ ownerId, actorKey, text: raw });
  }

  // 2) Spend / Revenue / Net / Profit totals (company)
  const wantsSpend = /\b(spend|spent|expenses?|costs?)\b/.test(s);
  const wantsRevenue = /\b(revenue|sales|earned|income)\b/.test(s);
  const wantsNet = /\b(net|cash flow|cashflow)\b/.test(s) && (wantsSpend || wantsRevenue);
  const wantsProfitTotal = /\bprofit\b|\bmargin\b/.test(s) && !/\bjob\b|#\d+|\bon\s+/.test(s); // avoid stealing job profit path

  // If they asked for totals and mentioned a time window (or implicit via effectiveRange)
  if (wantsSpend || wantsRevenue || wantsProfitTotal || wantsNet) {
    const totals = await totalsForRange({ ownerId, fromIso, toIso });

    // If we can’t compute totals, fall back safely.
    if (!totals.ok) {
      return {
        ok: true,
        route: "clarify",
        answer:
          `I can answer profit-by-job right now (e.g., “profit on job 1556”).\n` +
          `Spend/revenue totals need one more DB helper wired.\n\nTry:\n• “profit on job 1556”\n• “list jobs”`,
        evidence: { sql: [], facts_used: 0 },
      };
    }

    const label =
      effectiveRange === "today"
        ? "today"
        : effectiveRange === "wtd"
        ? "this week"
        : effectiveRange === "mtd"
        ? "this month"
        : effectiveRange === "ytd"
        ? "this year"
        : effectiveRange === "all"
        ? "all time"
        : effectiveRange === "last7"
        ? "last 7 days"
        : effectiveRange === "last30"
        ? "last 30 days"
        : "this period";

    const lines = [`For ${label}:`];
    if (wantsRevenue) lines.push(`• Revenue: ${money(totals.revenue)}`);
    if (wantsSpend) lines.push(`• Spend: ${money(totals.spend)}`);

    // Profit total (revenue - spend) for the period
    if (wantsProfitTotal) lines.push(`• Profit (revenue − spend): ${money(totals.net)}`);

    // If they explicitly asked for “net”
    if (wantsNet) lines.push(`• Net (revenue − spend): ${money(totals.net)}`);

    // Optional: “top 5 expenses” intent
    if (/\btop\s*(\d+)?\s*expenses?\b|\bbiggest\s*expenses?\b|\btop\s*categories\b/.test(s)) {
      const top = await topExpenseBreakdown({ ownerId, fromIso, toIso, limit: 5 });
      if (top.ok) {
        lines.push(``);
        lines.push(`Top expense categories:`);
        top.rows.forEach((r) => lines.push(`• ${r.category}: ${money(r.cents)}`));
      }
    }

    return {
      ok: true,
      route: "insight",
      answer: lines.join("\n"),
      evidence: { sql: ["sumExpensesCentsByRange", "sumRevenueCentsByRange"], facts_used: 2 },
    };
  }

  // 3) Cash in/out (best-effort)
  const wantsCash = /\bcash\b|\bbank\b|\bcashflow\b|\bcash flow\b/.test(s);
  const wantsIn = /\b(in|received|came in|collections)\b/.test(s);
  const wantsOut = /\b(out|spent|went out|payments)\b/.test(s);

  if (wantsCash && (wantsIn || wantsOut || /\bnet\b/.test(s))) {
    const cf = await cashflowForRange({ ownerId, fromIso, toIso });

    if (!cf.ok) {
      return {
        ok: true,
        route: "clarify",
        answer:
          `Cash-in/out isn’t wired yet for your schema (we can add it via v_cashflow_daily).\n\n` +
          `Try:\n• “spend this week”\n• “revenue this week”\n• “profit on job 1556”`,
        evidence: { sql: [], facts_used: 0 },
      };
    }

    const label =
      effectiveRange === "today"
        ? "today"
        : effectiveRange === "wtd"
        ? "this week"
        : effectiveRange === "mtd"
        ? "this month"
        : effectiveRange === "ytd"
        ? "this year"
        : "this period";

    const lines = [`Cash flow for ${label}:`];
    if (wantsIn) lines.push(`• Cash in: ${money(cf.inCents)}`);
    if (wantsOut) lines.push(`• Cash out: ${money(cf.outCents)}`);
    if (!wantsIn && !wantsOut) lines.push(`• Net cash flow: ${money(cf.netCents)}`);
    if (/\bnet\b/.test(s)) lines.push(`• Net cash flow: ${money(cf.netCents)}`);

    return { ok: true, route: "insight", answer: lines.join("\n"), evidence: { sql: ["v_cashflow_daily"], facts_used: 2 } };
  }

  // Fallback: good suggestions
  return {
    ok: true,
    route: "clarify",
    answer:
      `Try:\n` +
      `• “spend this week” / “spend this month”\n` +
      `• “revenue this week” / “revenue this month”\n` +
      `• “profit on job 1556”\n` +
      `• “top expenses this month”`,
    evidence: { sql: [], facts_used: 0 },
  };
}

module.exports = { answerInsightV0 };
