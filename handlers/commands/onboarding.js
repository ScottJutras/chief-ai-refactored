// handlers/commands/onboarding.js
// Minimal, fast onboarding with “magic moment” + first job creation.
// Uses public.settings (owner_id, key, value) as state store.

const pg = require('../../services/postgres');

// Optional: Twilio sender if you have it available in your codebase.
// If you already have a "sendWhatsAppText" / "sendWhatsAppMedia" helper, wire it in here.
let twilioClient = null;
try {
  twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} catch {}

function dbQuery(sql, params = []) {
  // supports pg.query OR pg.pool.query (both patterns are common in your repo)
  if (pg?.query) return pg.query(sql, params);
  if (pg?.pool?.query) return pg.pool.query(sql, params);
  throw new Error('postgres service has no query() or pool.query()');
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
    [String(ownerId), String(key), String(value ?? '')]
  );
}

function normCountry(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return null;

  if (['CA', 'CAN', 'CANADA'].includes(s)) return 'CA';
  if (['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'].includes(s)) return 'US';

  return null;
}

function normProvince(country, raw) {
  const s0 = String(raw || '').trim();
  if (!s0) return null;

  const s = s0.toUpperCase();

  if (country === 'CA') {
    // allow full names or 2-letter codes
    const map = {
      ON: 'ON', ONTARIO: 'ON',
      QC: 'QC', QUEBEC: 'QC',
      BC: 'BC', 'BRITISH COLUMBIA': 'BC',
      AB: 'AB', ALBERTA: 'AB',
      MB: 'MB', MANITOBA: 'MB',
      SK: 'SK', SASKATCHEWAN: 'SK',
      NS: 'NS', 'NOVA SCOTIA': 'NS',
      NB: 'NB', 'NEW BRUNSWICK': 'NB',
      NL: 'NL', 'NEWFOUNDLAND AND LABRADOR': 'NL',
      PE: 'PE', 'PRINCE EDWARD ISLAND': 'PE',
      NT: 'NT', 'NORTHWEST TERRITORIES': 'NT',
      NU: 'NU', NUNAVUT: 'NU',
      YT: 'YT', YUKON: 'YT'
    };
    return map[s] || (s.length >= 2 ? s.slice(0, 2) : null);
  }

  if (country === 'US') {
    // for MVP, just store 2-letter state code if possible
    return s.length >= 2 ? s.slice(0, 2) : null;
  }

  return null;
}

function computeCurrency(country) {
  if (country === 'CA') return 'CAD';
  if (country === 'US') return 'USD';
  return null;
}

function computeTaxCode(country, prov) {
  const p = String(prov || '').toUpperCase();
  if (country === 'US') return 'US_SALES_TAX';
  if (country !== 'CA') return 'NO_SALES_TAX';

  switch (p) {
    case 'ON': return 'HST_ON';
    case 'NS': return 'HST_NS';
    case 'NB': return 'HST_NB';
    case 'NL': return 'HST_NL';
    case 'PE': return 'HST_PE';
    case 'BC': return 'GST_PST_BC';
    case 'SK': return 'GST_PST_SK';
    case 'MB': return 'GST_PST_MB';
    case 'QC': return 'GST_PST_QC';
    case 'AB':
    case 'NT':
    case 'NU':
    case 'YT':
      return 'GST_ONLY';
    default:
      return 'NO_SALES_TAX';
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
  // use your canonical jobs table (public.jobs)
  // if your schema differs, this still won’t break onboarding; it only influences “needs first job”
  const { rows } = await dbQuery(
    `select count(*)::int as n from public.jobs where owner_id = $1`,
    [String(ownerId)]
  );
  return rows?.[0]?.n ?? 0;
}

async function bestEffortCreateJob({ ownerId, jobName, actorId }) {
  const name = String(jobName || '').trim();
  if (!name) return { ok: false, error: 'missing_name' };

  // Prefer your existing pg job helpers if present (most future-proof)
  try {
    if (typeof pg.createJobIdempotent === 'function') {
      const out = await pg.createJobIdempotent(ownerId, name, actorId);
      return { ok: true, out };
    }
  } catch {}

  try {
    if (typeof pg.createJob === 'function') {
      const out = await pg.createJob(ownerId, name, actorId);
      return { ok: true, out };
    }
  } catch {}

  // Last-resort SQL insert (may need adapting if your jobs schema differs)
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
    return { ok: false, error: e?.message || 'insert_failed' };
  }
}

async function sendWhatsAppText({ fromPhone, body }) {
  // Your webhook likely replies with TwiML immediately; onboarding should also reply via TwiML.
  // This helper is only here for future “out of band” sends.
  if (!twilioClient) return { ok: false, error: 'no_twilio_client' };
  if (!process.env.TWILIO_WHATSAPP_NUMBER) return { ok: false, error: 'missing_TWILIO_WHATSAPP_NUMBER' };

  const to = String(fromPhone || '').trim();
  const from = String(process.env.TWILIO_WHATSAPP_NUMBER || '').trim(); // should be "whatsapp:+1..."
  const msg = await twilioClient.messages.create({
    from,
    to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
    body: String(body || '')
  });
  return { ok: true, sid: msg?.sid || null };
}

async function sendWhatsAppVideo({ fromPhone, videoUrl, caption }) {
  // Works inside 24h window (user has messaged you recently). No template required for this immediate onboarding moment.
  if (!twilioClient) return { ok: false, error: 'no_twilio_client' };
  if (!process.env.TWILIO_WHATSAPP_NUMBER) return { ok: false, error: 'missing_TWILIO_WHATSAPP_NUMBER' };

  const to = String(fromPhone || '').trim();
  const from = String(process.env.TWILIO_WHATSAPP_NUMBER || '').trim();

  const msg = await twilioClient.messages.create({
    from,
    to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
    body: caption ? String(caption) : undefined,
    mediaUrl: [String(videoUrl)]
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
async function handleOnboardingInbound({
  ownerId,
  fromPhone,
  text2,
  tz,
  userProfile
}) {
  const raw = String(text2 || '').trim();
  const lc = raw.toLowerCase();

  // Owner can opt out quickly
  if (lc === 'skip' || lc === 'skip onboarding') {
    await setSetting(ownerId, 'onboarding.stage', 'done');
    return { handled: true, replyText: '✅ Skipped onboarding. Send an expense, revenue, timeclock, or “create job <name>”.' };
  }

  const stage = (await getSetting(ownerId, 'onboarding.stage')) || 'new';

  // Don’t intercept forever
  if (stage === 'done') return { handled: false };

  // If they start using the product immediately, don’t block them — but still ensure first-job strategy.
  const looksLikeImmediateUsage =
    /\b(expense|spent|revenue|invoice|receipt|clock in|clock out|timesheet|task)\b/i.test(raw);

  // If brand-new and they’re already sending real data, we let main router handle it
  // BUT we’ll still “prime” onboarding and let expense flow job-pick handle create-job.
  if (stage === 'new' && looksLikeImmediateUsage) {
    await setSetting(ownerId, 'onboarding.stage', 'welcomed');
    return { handled: false };
  }

  // Stage: new -> welcome
  if (stage === 'new') {
    await setSetting(ownerId, 'onboarding.stage', 'welcomed');

    // Use tenant locale already set, but allow quick correction
    const welcome = [
      `👋 Welcome to ChiefOS — I’ll get you set up in 30 seconds.`,
      ``,
      `I’ve set your location to:`,
      `• Country: CA`,
      `• Province/State: ON`,
      `• Timezone: ${tz || 'America/Toronto'}`,
      ``,
      `If that’s correct, reply: yes`,
      `If not, reply like: CA BC  (or)  US FL`,
      ``,
      `Tip: reply “skip” to skip onboarding.`
    ].join('\n');

    return { handled: true, replyText: welcome };
  }

  // Stage: welcomed -> capture locale confirmation or override
  if (stage === 'welcomed') {
    if (lc === 'yes' || lc === 'y') {
      await setSetting(ownerId, 'onboarding.stage', 'need_first_job');

      const nJobs = await listOpenJobsCount(ownerId);
      if (nJobs > 0) {
        await setSetting(ownerId, 'onboarding.stage', 'video');
        return { handled: true, replyText: `✅ Perfect. You already have jobs.\n\nWant a 60-second walkthrough video? Reply: video` };
      }

      return {
        handled: true,
        replyText: [
          `✅ Great.`,
          ``,
          `Last step: what’s your first job name?`,
          `Example: “Oak Street Re-roof”`,
          ``,
          `Reply with the job name (just the name).`
        ].join('\n')
      };
    }

    // Parse “CA BC” or “US FL”
    const parts = raw.split(/\s+/).filter(Boolean);
    const c = normCountry(parts[0]);
    const p = normProvince(c, parts[1]);

    if (!c) {
      return { handled: true, replyText: `Reply “yes” to confirm, or reply like: CA ON  (or)  US FL` };
    }

    await upsertTenantLocale({ ownerId, country: c, province: p || null, tz: tz || null });
    await setSetting(ownerId, 'onboarding.stage', 'need_first_job');

    return {
      handled: true,
      replyText: [
        `✅ Updated.`,
        ``,
        `Now: what’s your first job name?`,
        `Example: “Oak Street Re-roof”`,
        ``,
        `Reply with the job name (just the name).`
      ].join('\n')
    };
  }

  // Stage: need_first_job -> create the first job
  if (stage === 'need_first_job') {
    const jobName = raw;
    if (!jobName || jobName.length < 2) {
      return { handled: true, replyText: `Reply with a job name like: Oak Street Re-roof` };
    }

    const created = await bestEffortCreateJob({
      ownerId,
      jobName,
      actorId: String(userProfile?.user_id || userProfile?.wa_id || fromPhone || ownerId)
    });

    if (!created?.ok) {
      return {
        handled: true,
        replyText: `⚠️ I couldn’t create that job. Try: “create job ${jobName}” or reply with a slightly different name.`
      };
    }

    await setSetting(ownerId, 'onboarding.stage', 'video');

    return {
      handled: true,
      replyText: [
        `✅ Created your first job: “${jobName}”`,
        ``,
        `Want the 60-second walkthrough video?`,
        `Reply: video`,
        ``,
        `Or start right now:`,
        `• expense $18 Home Depot`,
        `• revenue $500 deposit`,
        `• send a receipt photo`
      ].join('\n')
    };
  }

  // Stage: video -> deliver video (inside 24h window, no template needed)
  if (stage === 'video') {
    if (lc !== 'video') {
      // Don’t block product usage
      await setSetting(ownerId, 'onboarding.stage', 'done');
      return { handled: false };
    }

    // You must host a public https video file (mp4). Put it in env so it’s easy to swap.
    const videoUrl = process.env.ONBOARDING_VIDEO_URL || '';
    if (!videoUrl) {
      await setSetting(ownerId, 'onboarding.stage', 'done');
      return {
        handled: true,
        replyText: `✅ Here’s the walkthrough: (add ONBOARDING_VIDEO_URL env var)\n\nIn the meantime, try: expense $18 Home Depot`
      };
    }

    // Best effort “out of band” send; but webhook still needs to reply something via TwiML.
    try {
      await sendWhatsAppVideo({
        fromPhone,
        videoUrl,
        caption: '🎥 60-second walkthrough'
      });
    } catch {}

    await setSetting(ownerId, 'onboarding.stage', 'done');
    await setSetting(ownerId, 'onboarding.video_sent_at', String(Date.now()));

    return {
      handled: true,
      replyText: [
        `✅ Sent the walkthrough video.`,
        ``,
        `Now try one:`,
        `• expense $18 Home Depot`,
        `• revenue $500 deposit`,
        `• clock in`,
        `• send a receipt photo`
      ].join('\n')
    };
  }

  return { handled: false };
}

module.exports = {
  handleOnboardingInbound
};