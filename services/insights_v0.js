// services/insights_v0.js
// MVP-safe deterministic insights (NO hallucinations)
// Goal: answer lots of business questions safely using only DB facts,
// and fall back to "clarify" with good suggestions (never crash).

const pg = require("./postgres");

function lc(s) {
  return String(s || "").toLowerCase();
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

// -------------------- Profit intent (shared) --------------------

// "profitability" must match. Also covers natural phrasing: "did it make money?"
const PROFIT_INTENT_RE =
  /\bprofitability\b|\bprofit\b|\bprofits\b|\bmargin\b|\bgross\s*margin\b|\bnet\s*margin\b|\bdid\s+it\s+make\s+money\b|\bmake\s+money\b|\bhow\s+much\s+(am\s+i|are\s+we)\s+making\b|\bwhat\s+(am\s+i|are\s+we)\s+making\b|\bmaking\b/i;

// -------------------- Range normalization --------------------

function normalizeRangeFromText(text, fallback = "mtd") {
  const t = String(text || "").toLowerCase();

  if (/\b(today|todays|today's)\b/.test(t)) return "today";
  if (/\b(wtd|week to date|this week)\b/.test(t)) return "wtd";
  if (/\b(mtd|month to date|this month)\b/.test(t)) return "mtd";
  if (/\b(ytd|year to date|this year)\b/.test(t)) return "ytd";
  if (/\b(all time|all)\b/.test(t)) return "all";

  if (/\b(last 7 days|past 7 days|previous 7 days)\b/.test(t)) return "last7";
  if (/\b(last 30 days|past 30 days|previous 30 days)\b/.test(t)) return "last30";
  if (/\b(last month|previous month)\b/.test(t)) return "prev_month";
  return fallback;
}

// -------------------- TZ-safe range resolver (NO NaN dates) --------------------

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function isoDateInTz(date, tz) {
  // en-CA => YYYY-MM-DD
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
  } catch {
    // If tz is invalid, fall back to system tz (still YYYY-MM-DD)
    return new Intl.DateTimeFormat("en-CA").format(date);
  }
}

function partsInTz(date, tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    }).formatToParts(date);
  }

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const wd = WEEKDAY_MAP[get("weekday")] ?? null;
  return { y, m, d, wd };
}

function addDaysUtcNoon(y, m, d, deltaDays) {
  // UTC noon avoids DST boundary weirdness.
  const base = Date.UTC(y, m - 1, d, 12, 0, 0);
  return new Date(base + deltaDays * 86400000);
}

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function hasExplicitRangeHint(text) {
  const t = lc(text);
  return /\b(today|todays|today's|wtd|week to date|this week|mtd|month to date|this month|ytd|year to date|this year|all time|all|last 7 days|past 7 days|previous 7 days|last 30 days|past 30 days|previous 30 days|last month|previous month)\b/.test(t);
}



/**
 * effectiveRange: today|wtd|mtd|ytd|last7|last30|all
 * tz: IANA timezone string (e.g., America/Toronto)
 */
function rangeToFromTo(effectiveRange, tz) {
  const now = new Date();
  const toIso = isoDateInTz(now, tz);
  const { y, m, d, wd } = partsInTz(now, tz);

  // Fail-closed: if anything is weird, return "today" safely.
  if (!y || !m || !d || wd == null || !isIsoDate(toIso)) {
    const safe = isIsoDate(toIso) ? toIso : "2000-01-01";
    return { fromIso: safe, toIso: safe };
  }

  const r = String(effectiveRange || "mtd").toLowerCase().trim();

  // Monday week start: Sun=0 -> 6, Mon=1 -> 0, ...
  const daysSinceMonday = (wd + 6) % 7;

  let fromDate;

  switch (r) {
    case "today":
      fromDate = addDaysUtcNoon(y, m, d, 0);
      break;

    case "wtd":
      fromDate = addDaysUtcNoon(y, m, d, -daysSinceMonday);
      break;

    case "mtd":
      fromDate = addDaysUtcNoon(y, m, 1, 0);
      break;

    case "ytd":
      fromDate = addDaysUtcNoon(y, 1, 1, 0);
      break;

    case "last7":
      fromDate = addDaysUtcNoon(y, m, d, -6); // inclusive window
      break;

    case "last30":
      fromDate = addDaysUtcNoon(y, m, d, -29); // inclusive window
      break;

    case "all":
      return { fromIso: "2000-01-01", toIso };

    default:
      // Unknown => treat as mtd
      fromDate = addDaysUtcNoon(y, m, 1, 0);
      break;
  
        case "prev_month": {
      // previous month in the user's TZ
      // Use tz parts (y,m) and build prev month boundaries safely at UTC noon.
      const prevY = m === 1 ? (y - 1) : y;
      const prevM = m === 1 ? 12 : (m - 1);

      // from: first day prev month
      const fromD = addDaysUtcNoon(prevY, prevM, 1, 0);

      // to: last day prev month = day 0 of current month
      // Use UTC noon trick again:
      const toD = new Date(Date.UTC(y, m - 1, 0, 12, 0, 0));

      const fromIsoPm = isoDateInTz(fromD, tz);
      const toIsoPm = isoDateInTz(toD, tz);

      return {
        fromIso: isIsoDate(fromIsoPm) ? fromIsoPm : toIso,
        toIso: isIsoDate(toIsoPm) ? toIsoPm : toIso,
      };
    }

    }

  const fromIso = isoDateInTz(fromDate, tz);

  // Final guard: never return NaN-ish strings.
  return {
    fromIso: isIsoDate(fromIso) ? fromIso : toIso,
    toIso: isIsoDate(toIso) ? toIso : fromIso,
  };
}

// -------------------- Job profit (existing strong path) --------------------
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
    const isProfitIntent = PROFIT_INTENT_RE.test(s);

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
  // Accept "profitability ..." too
  const m = t.match(/^\s*(?:profitability|profit|margin)\s+([\s\S]+)$/i);
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
    const hasProfitIntent = PROFIT_INTENT_RE.test(s);

  // Job anchors: "job 1556", "job #1556", "#1556", "active job", "on Medway Park"
  const hasJobAnchor =
    /\bjob\b/.test(s) ||
    /(^|\s)#\s*\d{1,10}\b/.test(s) ||
    /\bjob\s*#\s*\d{1,10}\b/.test(s) ||
    /\bjob\s+\d{1,10}\b/.test(s) ||
    /\bactive\s+job\b/.test(s) ||
    /\bon\s+[a-z0-9]/.test(s) || 
    /^\s*(profitability|profit|margin)\s+\d{2,10}\b/.test(s);

  return hasProfitIntent && hasJobAnchor;
}

async function getJobByIdForOwner(pgClient, ownerId, jobId) {
  const owner = String(ownerId || "").trim();
  const jid = Number(jobId);
  if (!owner || !Number.isFinite(jid)) return null;

  try {
    const r = await pgClient.query(
      `
      select id, job_no, coalesce(name, job_name) as job_name, active, status
      from public.jobs
      where owner_id::text = $1 and id = $2
      limit 1
      `,
      [owner, jid]
    );
    return r?.rows?.[0] || null;
  } catch {
    return null;
  }
}

async function resolveJobForProfit({ ownerId, actorKey, text, actorMemory }) {
  const raw = String(text || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
  const s = raw.toLowerCase();

  const explicitActive = /\bactive\s+job\b/.test(s);
  const ref = extractJobRefFromText(raw);

  const explicitRefProvided = !!(
    ref &&
    (ref.kind === "job_no" || (ref.name && String(ref.name).trim()) || (ref.raw && String(ref.raw).trim()))
  );

  // 1) If they explicitly asked for "active job", prefer the DB active job
  if (explicitActive) {
    try {
      if (typeof pg.getActiveJob === "function") {
        const aj = await pg.getActiveJob(ownerId, actorKey);
        if (aj && typeof aj === "object" && aj.job_no != null) {
          return {
            jobId: aj.id != null ? Number(aj.id) : null,
            jobNo: Number(aj.job_no),
            jobName: aj.name || aj.job_name || null,
            source: "active_job",
          };
        }
      }
    } catch {}
    // If no active job, continue to explicit ref resolution below
  }

  // 2) Conversation memory fallback (canonical first): active_job_id
  const convo =
    actorMemory?.conversation && typeof actorMemory.conversation === "object" ? actorMemory.conversation : {};

  const memJobId = Number(convo.active_job_id);
  if (!explicitRefProvided && Number.isFinite(memJobId)) {
    const job = await getJobByIdForOwner(pg, ownerId, memJobId);
    if (job) {
      return {
        jobId: Number(job.id),
        jobNo: Number(job.job_no),
        jobName: job.job_name || null,
        source: "memory_active_job_id",
      };
    }
    // If memory points to a missing job, fall through (do NOT block)
  }

  // 3) Secondary memory fallback: active_job_no (less canonical)
  const memJobNo = Number(convo.active_job_no);
  if (!explicitRefProvided && Number.isFinite(memJobNo)) {
    return { jobId: null, jobNo: memJobNo, jobName: convo.active_job_name || null, source: "memory_active_job_no" };
  }

  // 4) Resolve from explicit provided ref (job number or name)
  const resolved = await resolveJobForInsight(pg, ownerId, ref);

  if (resolved?.ok && resolved?.job) {
    return {
      jobId: resolved.job.id != null ? Number(resolved.job.id) : null,
      jobNo: Number(resolved.job.job_no),
      jobName: resolved.job.job_name || null,
      source: resolved.mode || "resolved",
    };
  }

  if (resolved?.reason === "ambiguous") {
    return {
      jobId: null,
      jobNo: null,
      jobName: null,
      source: "ambiguous",
      matches: resolved.matches || [],
      term: resolved.term || ref?.raw || ref?.name || "",
    };
  }

  if (explicitRefProvided && !explicitActive) {
    return {
      jobId: null,
      jobNo: null,
      jobName: null,
      source: "not_found_explicit",
      term: String(resolved?.term || ref?.raw || ref?.name || ref?.jobNo || "").trim(),
    };
  }

  // 5) Fall back to active job when no explicit ref was provided
  try {
    if (typeof pg.getActiveJob === "function") {
      const aj = await pg.getActiveJob(ownerId, actorKey);
      if (aj && typeof aj === "object" && aj.job_no != null) {
        return {
          jobId: aj.id != null ? Number(aj.id) : null,
          jobNo: Number(aj.job_no),
          jobName: aj.name || aj.job_name || null,
          source: "active_job",
        };
      }
    }
  } catch {}

  return { jobId: null, jobNo: null, jobName: null, source: resolved?.reason || "none" };
}

async function answerProfitIntent({ ownerId, actorKey, text, actorMemory, fromIso, toIso, label, effectiveRange, explicitRange }) {
  const resolved = await resolveJobForProfit({ ownerId, actorKey, text, actorMemory });

  console.info("[INSIGHTS_PROFIT_RESOLVED]", {
    ownerId,
    text: String(text || "").slice(0, 80),
    source: resolved?.source || null,
    jobId: resolved?.jobId ?? null,
    jobNo: resolved?.jobNo ?? null,
    jobName: resolved?.jobName ?? null,
    effectiveRange: effectiveRange || null,
    fromIso: fromIso || null,
    toIso: toIso || null,
  });

  if (!Number.isFinite(Number(resolved?.jobNo))) {
    if (resolved?.source === "ambiguous" && Array.isArray(resolved?.matches) && resolved.matches.length) {
      const options = resolved.matches
        .slice(0, 5)
        .map((j) => `• Job #${j.job_no} — ${j.job_name || "Unnamed"}`)
        .join("\n");

      return {
        ok: true,
        route: "clarify",
        answer: `Which job did you mean?\n\n${options}\n\nReply with the job number (e.g., “profit on job 1556”).`,
        evidence: { sql: [], facts_used: 0 },
      };
    }

    return {
      ok: true,
      route: "clarify",
      answer: `Tell me the job (e.g., “profit on job 1556” or “profit on Oak Street Re-roof”).`,
      evidence: { sql: [], facts_used: 0 },
    };
  }

  const requestedJobNo = Number(resolved.jobNo);

  // Decide whether we should attempt ranged job profit
  const hasRange = /^\d{4}-\d{2}-\d{2}$/.test(String(fromIso || "")) && /^\d{4}-\d{2}-\d{2}$/.test(String(toIso || ""));
  const wantsRanged = !!(hasRange && (explicitRange || (effectiveRange && effectiveRange !== "all")));

  // 1) RANGED PROFIT PATH (transactions-first)
  if (wantsRanged && typeof pg.getJobProfitByRange === "function") {
    try {
      const r = await pg.getJobProfitByRange({
        ownerId,
        jobId: Number.isFinite(Number(resolved?.jobId)) ? Number(resolved.jobId) : null,
        jobNo: requestedJobNo,
        fromIso,
        toIso,
      });

      if (r?.ok && r?.row) {
        const row = {
          job_no: requestedJobNo,
          job_name: resolved.jobName || `Job #${requestedJobNo}`,
          revenue_cents: Number(r.row.revenue_cents || 0),
          expense_cents: Number(r.row.expense_cents || 0),
          profit_cents: Number(r.row.profit_cents || 0),
        };

        const memory_patch = {
          conversation: {
            active_job_id: Number.isFinite(Number(resolved?.jobId)) ? Number(resolved.jobId) : null,
            active_job_no: requestedJobNo,
            active_job_name: resolved.jobName || null,
            last_intent: "profit",
            last_topic: "job_profit",
          },
        };

        return {
          ok: true,
          route: "insight",
          answer: [
            `📌 ${row.job_name}`,
            ``,
            `For ${label || "this period"}:`,
            `Revenue: ${money(row.revenue_cents)}`,
            `Spend: ${money(row.expense_cents)}`,
            `Profit: ${money(row.profit_cents)}`,
          ].join("\n"),
          evidence: { sql: ["transactions/getJobProfitByRange"], facts_used: 3 },
          memory_patch,
        };
      }

      // Fail closed to all-time if schema can’t support job linkage
      if (r?.reason === "no_job_link_columns" || r?.reason === "missing_job_key_for_available_mode") {
        // fall through to all-time (but be transparent if they asked for a range)
      }
    } catch {}
  }

  // 2) ALL-TIME fallback (existing stable path)
  const row = await getProfitRowByJobNo(ownerId, requestedJobNo);

  if (row) {
    const memory_patch = {
      conversation: {
        active_job_id: Number.isFinite(Number(resolved?.jobId)) ? Number(resolved.jobId) : null,
        active_job_no: requestedJobNo,
        active_job_name: row?.job_name || resolved.jobName || null,
        last_intent: "profit",
        last_topic: "job_profit",
      },
    };

    const askedForRangeButWeCant = wantsRanged; // they asked “last month” etc.

    return {
      ok: true,
      route: "insight",
      answer:
        profitReply({ row, label: row.job_name || resolved.jobName || `Job #${requestedJobNo}` }) +
        (askedForRangeButWeCant
          ? `\n\nNote: job profit by date range isn’t fully wired yet, so this is all-time for that job.`
          : ``),
      evidence: { sql: ["v_job_profit_simple_fixed/getJobProfitSimple"], facts_used: 4 },
      memory_patch,
    };
  }

  return {
    ok: true,
    route: "clarify",
    answer: `I couldn’t find Job #${requestedJobNo}. Try “list jobs” or tell me the job name.`,
    evidence: { sql: [], facts_used: 0 },
  };
}
// ---- End: profit helpers ----

// -------------------- Main entry --------------------

async function answerInsightV0({ ownerId, actorKey, text, tz, context = {} }) {
  const raw = String(text || "").trim();
  const s = lc(raw);
  const tzUse = String(tz || "").trim() || "America/Toronto";

  const mem = context?.actorMemory || {};
  const convo = mem?.conversation && typeof mem.conversation === "object" ? mem.conversation : {};

  // Range preference:
  // - if user explicitly specified a range -> use it
  // - else fall back to convo.active_range
  const explicitRange = hasExplicitRangeHint(raw);
  const fallbackRange = String(convo.active_range || "mtd").trim() || "mtd";

  // (0) Range (compute ONCE)
  const effectiveRange = normalizeRangeFromText(raw, explicitRange ? "mtd" : fallbackRange);

  const memoryPatchBase = {
    conversation: {
      active_range: effectiveRange,
      updated_at: isoDateInTz(new Date(), tzUse),
    },
  };

  let { fromIso, toIso } = rangeToFromTo(effectiveRange, tzUse);

  console.info("[INSIGHTS_RANGE_RESOLVED]", {
    ownerId,
    text: raw.slice(0, 80),
    effectiveRange,
    fromIso,
    toIso,
  });

  // ✅ One more tiny safeguard
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromIso) || !/^\d{4}-\d{2}-\d{2}$/.test(toIso)) {
    console.warn("[INSIGHTS_RANGE_INVALID] forcing today", { fromIso, toIso, effectiveRange, tz: tzUse });
    const safe = rangeToFromTo("today", tzUse);
    fromIso = safe.fromIso;
    toIso = safe.toIso;
  }

  // Helper: pretty label
  const label =
    effectiveRange === "today" ? "today" :
    effectiveRange === "wtd" ? "this week" :
    effectiveRange === "mtd" ? "this month" :
    effectiveRange === "prev_month" ? "last month" :
    effectiveRange === "ytd" ? "this year" :
    effectiveRange === "last7" ? "last 7 days" :
    effectiveRange === "last30" ? "last 30 days" :
    effectiveRange === "all" ? "all time" :
    "this period";

    // 1) Profit / margin (job)
  if (looksLikeProfitQuestion(raw)) {
  const out = await answerProfitIntent({
    ownerId,
    actorKey,
    text: raw,
    actorMemory: mem,
    fromIso,
    toIso,
    label,
    effectiveRange,
    explicitRange: hasExplicitRangeHint(raw),
  });

    // Persist: last_intent="profit" when we detect profit intent
    if (out && typeof out === "object") {
      out.memory_patch = {
        conversation: {
          ...(memoryPatchBase.conversation || {}),
          ...(out.memory_patch?.conversation || {}),
          last_intent: "profit",
          last_topic: "job_profit",
        },
      };
    }
    return out;
  }

  // 1b) Range-only follow-up: reuse last intent deterministically
  // Example: after "profit on job 1556", user says "what about last month?"
  if (isRangeOnlyFollowup(raw)) {
    const lastIntent = String(convo.last_intent || "").trim();

    if (lastIntent === "profit") {
      // If we have an active job in memory, re-run profit using the new range context (range is already set above)
      // NOTE: job profit currently ignores range because it uses v_job_profit_simple_fixed (all-time).
      // We still keep range sticky for other intents and for future job-profit-by-range wiring.
      const out = await answerProfitIntent({ ownerId, actorKey, text: raw, actorMemory: mem });
      if (out && typeof out === "object") {
        out.memory_patch = {
          conversation: {
            ...(memoryPatchBase.conversation || {}),
            ...(out.memory_patch?.conversation || {}),
            last_intent: "profit",
            last_topic: "job_profit",
          },
        };
      }
      return out;
    }

    if (lastIntent === "totals") {
      // Re-run totals using the new range, based on what they asked last time (stored below)
      const lastTotalsMode = String(convo.last_totals_mode || "spend").trim(); // spend|revenue|profit|top_expenses
      const wantsSpend = lastTotalsMode === "spend";
      const wantsRevenue = lastTotalsMode === "revenue";
      const wantsProfit = lastTotalsMode === "profit";
      const wantsTopExpenses = lastTotalsMode === "top_expenses";

      const spendCents = await pg.sumExpensesCentsByRange({ ownerId, fromIso, toIso });
      const revenueCents = await pg.sumRevenueCentsByRange({ ownerId, fromIso, toIso });
      const profitCents = Number(revenueCents || 0) - Number(spendCents || 0);

      const lines = [`For ${label}:`];
      if (wantsRevenue) lines.push(`• Revenue: ${money(revenueCents)}`);
      if (wantsSpend) lines.push(`• Spend: ${money(spendCents)}`);
      if (wantsProfit) lines.push(`• Profit (revenue − spend): ${money(profitCents)}`);

      if (wantsTopExpenses) {
        const topCats = await pg.topExpenseCategoriesByRange?.({ ownerId, fromIso, toIso, limit: 5 });
        const topVendors = await pg.topExpenseVendorsByRange?.({ ownerId, fromIso, toIso, limit: 5 });

        const catRows = Array.isArray(topCats?.rows) ? topCats.rows : [];
        const venRows = Array.isArray(topVendors?.rows) ? topVendors.rows : [];

        if (catRows.length || venRows.length) lines.push("");

        if (catRows.length) {
          lines.push("Top expense categories:");
          catRows.forEach((r) => {
            const name = String(r.category || "Uncategorized").trim() || "Uncategorized";
            const cents = Number(r.cents || 0);
            lines.push(`• ${name}: ${money(cents)}`);
          });
        }

        if (venRows.length) {
          if (catRows.length) lines.push("");
          lines.push("Top vendors:");
          venRows.forEach((r) => {
            const name = String(r.vendor || "Unknown").trim() || "Unknown";
            const cents = Number(r.cents || 0);
            lines.push(`• ${name}: ${money(cents)}`);
          });
        }
      }

      return {
        ok: true,
        route: "insight",
        answer: lines.join("\n"),
        evidence: { sql: ["sumExpensesCentsByRange", "sumRevenueCentsByRange"], facts_used: 2 },
        memory_patch: {
          conversation: {
            ...(memoryPatchBase.conversation || {}),
            last_intent: "totals",
            last_topic: "totals",
            last_totals_mode: lastTotalsMode,
          },
        },
      };
    }

    // If we don't know the last intent, keep it tight (no guessing)
    return {
      ok: true,
      route: "clarify",
      answer: `What should I run for ${label} — spend, revenue, profit, or top expenses?`,
      evidence: { sql: [], facts_used: 0 },
      memory_patch: memoryPatchBase,
    };
  }

  // 2) Business totals (spend / revenue / profit / top expenses)
  const intent = detectIntent(raw);

  if (intent.anyTotals) {
    const spendCents = await pg.sumExpensesCentsByRange({ ownerId, fromIso, toIso });
    const revenueCents = await pg.sumRevenueCentsByRange({ ownerId, fromIso, toIso });
    const profitCents = Number(revenueCents || 0) - Number(spendCents || 0);

    const lines = [`For ${label}:`];

    if (intent.wantsRevenue) lines.push(`• Revenue: ${money(revenueCents)}`);
    if (intent.wantsSpend) lines.push(`• Spend: ${money(spendCents)}`);
    if (intent.wantsProfit) lines.push(`• Profit (revenue − spend): ${money(profitCents)}`);

    if (intent.wantsTopExpenses) {
      const topCats = await pg.topExpenseCategoriesByRange?.({ ownerId, fromIso, toIso, limit: 5 });
      const topVendors = await pg.topExpenseVendorsByRange?.({ ownerId, fromIso, toIso, limit: 5 });

      const catRows = Array.isArray(topCats?.rows) ? topCats.rows : [];
      const venRows = Array.isArray(topVendors?.rows) ? topVendors.rows : [];

      if (catRows.length || venRows.length) lines.push("");

      if (catRows.length) {
        lines.push("Top expense categories:");
        catRows.forEach((r) => {
          const name = String(r.category || "Uncategorized").trim() || "Uncategorized";
          const cents = Number(r.cents || 0);
          lines.push(`• ${name}: ${money(cents)}`);
        });
      }

      if (venRows.length) {
        if (catRows.length) lines.push("");
        lines.push("Top vendors:");
        venRows.forEach((r) => {
          const name = String(r.vendor || "Unknown").trim() || "Unknown";
          const cents = Number(r.cents || 0);
          lines.push(`• ${name}: ${money(cents)}`);
        });
      }

      if (!pg.topExpenseCategoriesByRange || !pg.topExpenseVendorsByRange) {
        lines.push("");
        lines.push("Note: “top expenses” breakdown isn’t fully wired yet (needs 2 SQL helpers on transactions).");
      }
    }

    // Determine last_totals_mode for range-only followups
    const lastTotalsMode =
      intent.wantsTopExpenses ? "top_expenses" :
      intent.wantsProfit ? "profit" :
      intent.wantsRevenue ? "revenue" :
      intent.wantsSpend ? "spend" :
      "spend";

    return {
      ok: true,
      route: "insight",
      answer: lines.join("\n"),
      evidence: {
        sql: [
          "sumExpensesCentsByRange",
          "sumRevenueCentsByRange",
          ...(intent.wantsTopExpenses ? ["topExpenseCategoriesByRange", "topExpenseVendorsByRange"] : []),
        ],
        facts_used: 2,
      },
      memory_patch: {
        conversation: {
          ...(memoryPatchBase.conversation || {}),
          last_intent: "totals",
          last_topic: "totals",
          last_totals_mode: lastTotalsMode,
        },
      },
    };
  }

  // 3) Cash-in/out (best-effort stub)
  if (intent.wantsCash) {
    return {
      ok: true,
      route: "clarify",
      answer:
        `Cash-in/out isn’t wired yet for your schema (we can add it via v_cashflow_daily).\n\n` +
        `Try:\n• “spend ${label}”\n• “revenue ${label}”\n• “top expenses ${label}”\n• “profit on job 1556”`,
      evidence: { sql: [], facts_used: 0 },
      memory_patch: {
        conversation: {
          ...(memoryPatchBase.conversation || {}),
          last_intent: "cashflow",
          last_topic: "cashflow",
        },
      },
    };
  }

  // Fallback
  return {
    ok: true,
    route: "clarify",
    answer:
      `Try:\n` +
      `• “spend this week” / “spend this month”\n` +
      `• “revenue this week” / “revenue this month”\n` +
      `• “top expenses this month”\n` +
      `• “profit on job 1556”`,
    evidence: { sql: [], facts_used: 0 },
    memory_patch: memoryPatchBase,
  };
}

module.exports = { answerInsightV0 };