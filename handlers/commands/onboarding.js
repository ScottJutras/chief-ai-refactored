// handlers/commands/onboarding.js
// Minimal, fast onboarding with “magic moment” + first job creation.
// Uses public.settings (owner_id, key, value) as state store.

const pg = require("../../services/postgres");

// Optional: Twilio sender if you have it available in your codebase.
let twilioClient = null;
try {
  twilioClient = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} catch {}

/* ---------------- Helpers ---------------- */

function dbQuery(sql, params = []) {
  // supports pg.query OR pg.pool.query (both patterns are common in your repo)
  if (pg?.query) return pg.query(sql, params);
  if (pg?.pool?.query) return pg.pool.query(sql, params);
  throw new Error("postgres service has no query() or pool.query()");
}

function portalUrl() {
  // Prefer explicit portal URL; fall back to APP_BASE_URL; then hard fallback
  const u =
    process.env.PORTAL_BASE_URL ||
    process.env.APP_BASE_URL ||
    "https://www.usechiefos.com/app";
  return String(u).replace(/\/$/, "");
}

async function getSetting(ownerId, key) {
  const { rows } = await dbQuery(
    `select value from public.settings where owner_id = $1 and key = $2 limit 1`,
    [String(ownerId), String(key)]
  );
  return rows?.[0]?.value ?? null;
}

async function setSetting(ownerId, key, value) {
  await dbQuery(
    `
    insert into public.settings (owner_id, key, value)
    values ($1, $2, $3)
    on conflict (owner_id, key)
    do update set value = excluded.value, updated_at = now()
    `,
    [String(ownerId), String(key), String(value ?? "")]
  );
}

function normCountry(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return null;

  if (["CA", "CAN", "CANADA"].includes(s)) return "CA";
  if (["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"].includes(s)) return "US";

  return null;
}

function normProvince(country, raw) {
  const s0 = String(raw || "").trim();
  if (!s0) return null;

  const s = s0.toUpperCase();

  if (country === "CA") {
    // allow full names or 2-letter codes
    const map = {
      ON: "ON",
      ONTARIO: "ON",
      QC: "QC",
      QUEBEC: "QC",
      BC: "BC",
      "BRITISH COLUMBIA": "BC",
      AB: "AB",
      ALBERTA: "AB",
      MB: "MB",
      MANITOBA: "MB",
      SK: "SK",
      SASKATCHEWAN: "SK",
      NS: "NS",
      "NOVA SCOTIA": "NS",
      NB: "NB",
      "NEW BRUNSWICK": "NB",
      NL: "NL",
      "NEWFOUNDLAND AND LABRADOR": "NL",
      PE: "PE",
      "PRINCE EDWARD ISLAND": "PE",
      NT: "NT",
      "NORTHWEST TERRITORIES": "NT",
      NU: "NU",
      NUNAVUT: "NU",
      YT: "YT",
      YUKON: "YT",
    };
    return map[s] || (s.length >= 2 ? s.slice(0, 2) : null);
  }

  if (country === "US") {
    // for MVP, just store 2-letter state code if possible
    return s.length >= 2 ? s.slice(0, 2) : null;
  }

  return null;
}

function computeCurrency(country) {
  if (country === "CA") return "CAD";
  if (country === "US") return "USD";
  return null;
}

function computeTaxCode(country, prov) {
  const p = String(prov || "").toUpperCase();
  if (country === "US") return "US_SALES_TAX";
  if (country !== "CA") return "NO_SALES_TAX";

  switch (p) {
    case "ON":
      return "HST_ON";
    case "NS":
      return "HST_NS";
    case "NB":
      return "HST_NB";
    case "NL":
      return "HST_NL";
    case "PE":
      return "HST_PE";
    case "BC":
      return "GST_PST_BC";
    case "SK":
      return "GST_PST_SK";
    case "MB":
      return "GST_PST_MB";
    case "QC":
      return "GST_PST_QC";
    case "AB":
    case "NT":
    case "NU":
    case "YT":
      return "GST_ONLY";
    default:
      return "NO_SALES_TAX";
  }
}

async function upsertTenantLocale({ ownerId, country, province, tz }) {
  const currency = computeCurrency(country);
  const tax_code = computeTaxCode(country, province);

  await dbQuery(
    `
    update public.chiefos_tenants
    set
      country  = coalesce($2, country),
      province = coalesce($3, province),
      tz       = coalesce($4, tz),
      currency = coalesce($5, currency),
      tax_code = coalesce($6, tax_code)
    where owner_id = $1
    `,
    [String(ownerId), country, province, tz, currency, tax_code]
  );
}

async function listOpenJobsCount(ownerId) {
  const { rows } = await dbQuery(`select count(*)::int as n from public.jobs where owner_id = $1`, [
    String(ownerId),
  ]);
  return rows?.[0]?.n ?? 0;
}

async function bestEffortCreateJob({ ownerId, jobName, actorId }) {
  const name = String(jobName || "").trim();
  if (!name) return { ok: false, error: "missing_name" };

  try {
    if (typeof pg.createJobIdempotent === "function") {
      const out = await pg.createJobIdempotent(ownerId, name, actorId);
      return { ok: true, out };
    }
  } catch {}

  try {
    if (typeof pg.createJob === "function") {
      const out = await pg.createJob(ownerId, name, actorId);
      return { ok: true, out };
    }
  } catch {}

  try {
    const { rows } = await dbQuery(
      `
      insert into public.jobs (owner_id, name, status, created_at)
      values ($1, $2, 'open', now())
      returning *
      `,
      [String(ownerId), name]
    );
    return { ok: true, out: rows?.[0] || null };
  } catch (e) {
    return { ok: false, error: e?.message || "insert_failed" };
  }
}

async function sendWhatsAppVideo({ fromPhone, videoUrl, caption }) {
  if (!twilioClient) return { ok: false, error: "no_twilio_client" };
  if (!process.env.TWILIO_WHATSAPP_NUMBER) return { ok: false, error: "missing_TWILIO_WHATSAPP_NUMBER" };

  const to = String(fromPhone || "").trim();
  const from = String(process.env.TWILIO_WHATSAPP_NUMBER || "").trim();

  const msg = await twilioClient.messages.create({
    from,
    to: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
    body: caption ? String(caption) : undefined,
    mediaUrl: [String(videoUrl)],
  });

  return { ok: true, sid: msg?.sid || null };
}

/**
 * Main entry: decides if onboarding should intercept this inbound message.
 *
 * Returns:
 *   { handled: true, replyText: '...' }  -> webhook should respond with this and STOP
 *   { handled: false }                  -> webhook continues normal routing
 */
async function handleOnboardingInbound({ ownerId, fromPhone, text2, tz, userProfile }) {
  const raw = String(text2 || "").trim();
  const lc = raw.toLowerCase();

  // Owner can opt out quickly
  if (lc === "skip" || lc === "skip onboarding") {
    await setSetting(ownerId, "onboarding.stage", "done");
    return {
      handled: true,
      replyText: `✅ Skipped onboarding.\n\nPortal: ${portalUrl()}\n\nSend an expense, revenue, timeclock, or “create job <name>”.\n\nTip: Send 'commands' anytime to see everything Chief can do.`,
    };
  }

  const stage = (await getSetting(ownerId, "onboarding.stage")) || "new";

  // Don’t intercept forever
  if (stage === "done") return { handled: false };

  // If they start using the product immediately, don’t block them
  const looksLikeImmediateUsage = /\b(expense|spent|revenue|invoice|receipt|clock in|clock out|timesheet|task)\b/i.test(
    raw
  );

  if (stage === "new" && looksLikeImmediateUsage) {
    await setSetting(ownerId, "onboarding.stage", "welcomed");
    return { handled: false };
  }

  // Stage: new -> welcome
  if (stage === "new") {
    await setSetting(ownerId, "onboarding.stage", "welcomed");

    const welcome = [
      `👋 Welcome to ChiefOS — I’ll get you set up in 30 seconds.`,
      ``,
      `Portal: ${portalUrl()}`,
      `Tip: In the portal you can generate a link code to connect employees.`,
      ``,
      `I’ve set your location to:`,
      `• Country: CA`,
      `• Province/State: ON`,
      `• Timezone: ${tz || "America/Toronto"}`,
      ``,
      `If that’s correct, reply: yes`,
      `If not, reply like: CA BC  (or)  US FL`,
      ``,
      `Tip: reply “skip” to skip onboarding.`,
    ].join("\n");

    return { handled: true, replyText: welcome };
  }

  // Stage: welcomed -> capture locale confirmation or override
  if (stage === "welcomed") {
    if (lc === "yes" || lc === "y") {
      await setSetting(ownerId, "onboarding.stage", "need_first_job");

      const nJobs = await listOpenJobsCount(ownerId);
      if (nJobs > 0) {
        await setSetting(ownerId, "onboarding.stage", "video");
        return {
          handled: true,
          replyText: `✅ Perfect. You already have jobs.\n\nPortal: ${portalUrl()}\n\nWant a 60-second walkthrough video? Reply: video`,
        };
      }

      return {
        handled: true,
        replyText: [
          `✅ Great.`,
          ``,
          `Portal: ${portalUrl()}`,
          ``,
          `Last step: what’s your first job name?`,
          `Example: “Oak Street Re-roof”`,
          ``,
          `Reply with the job name (just the name).`,
        ].join("\n"),
      };
    }

    const parts = raw.split(/\s+/).filter(Boolean);
    const c = normCountry(parts[0]);
    const p = normProvince(c, parts[1]);

    if (!c) {
      return { handled: true, replyText: `Reply “yes” to confirm, or reply like: CA ON  (or)  US FL` };
    }

    await upsertTenantLocale({ ownerId, country: c, province: p || null, tz: tz || null });
    await setSetting(ownerId, "onboarding.stage", "need_first_job");

    return {
      handled: true,
      replyText: [
        `✅ Updated.`,
        ``,
        `Portal: ${portalUrl()}`,
        ``,
        `Now: what’s your first job name?`,
        `Example: “Oak Street Re-roof”`,
        ``,
        `Reply with the job name (just the name).`,
      ].join("\n"),
    };
  }

  // Stage: need_first_job -> create the first job
  if (stage === "need_first_job") {
    const jobName = raw;
    if (!jobName || jobName.length < 2) {
      return { handled: true, replyText: `Reply with a job name like: Oak Street Re-roof` };
    }

    const created = await bestEffortCreateJob({
      ownerId,
      jobName,
      actorId: String(userProfile?.user_id || userProfile?.wa_id || fromPhone || ownerId),
    });

    if (!created?.ok) {
      return {
        handled: true,
        replyText: `⚠️ I couldn’t create that job.\n\nTry: “create job ${jobName}” or reply with a slightly different name.\n\nPortal: ${portalUrl()}`,
      };
    }

    await setSetting(ownerId, "onboarding.stage", "video");

    return {
      handled: true,
      replyText: [
        `✅ Created your first job: “${jobName}”`,
        ``,
        `Portal: ${portalUrl()}`,
        ``,
        `Want the 60-second walkthrough video?`,
        `Reply: video`,
        ``,
        `Or start right now:`,
        `• expense $18 Home Depot`,
        `• revenue $500 deposit`,
        `• send a receipt photo`,
      ].join("\n"),
    };
  }

  // Stage: video -> deliver video
  if (stage === "video") {
    if (lc !== "video") {
      await setSetting(ownerId, "onboarding.stage", "done");
      return { handled: false };
    }

    const videoUrl = process.env.ONBOARDING_VIDEO_URL || "";
    if (!videoUrl) {
      await setSetting(ownerId, "onboarding.stage", "done");
      return {
        handled: true,
        replyText: `✅ Walkthrough video is not configured yet.\n\nPortal: ${portalUrl()}\n\nIn the meantime, try: expense $18 Home Depot\n\nTip: Send 'commands' anytime to see everything Chief can do.`,
      };
    }

    try {
      await sendWhatsAppVideo({
        fromPhone,
        videoUrl,
        caption: "🎥 60-second walkthrough",
      });
    } catch {}

    await setSetting(ownerId, "onboarding.stage", "done");
    await setSetting(ownerId, "onboarding.video_sent_at", String(Date.now()));

    return {
      handled: true,
      replyText: [
        `✅ Sent the walkthrough video.`,
        ``,
        `Portal: ${portalUrl()}`,
        ``,
        `Now try one:`,
        `• expense $18 Home Depot`,
        `• revenue $500 deposit`,
        `• clock in`,
        `• send a receipt photo`,
        ``,
        `Tip: Send 'commands' anytime to see everything Chief can do.`,
      ].join("\n"),
    };
  }

  return { handled: false };
}