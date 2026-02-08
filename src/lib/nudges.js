// src/lib/nudges.js
// Opportunistic nudges — no cron required.

async function maybeNudgeOwnerForProSelfLogging(pg, { owner_id, toPhone, sendText }) {
  if (!pg?.query || !owner_id || !toPhone || typeof sendText !== "function") return false;

  // Threshold
  const { rows } = await pg.query(
    `
    select count(*)::int as hits
    from capability_denials
    where owner_id = $1
      and reason_code = 'EMPLOYEE_SELF_LOGGING_REQUIRES_PRO'
      and created_at > now() - interval '7 days'
    `,
    [String(owner_id).trim()]
  );

  const hits = Number(rows?.[0]?.hits || 0);
  if (hits < 3) return false;

  const nudgeKey = "pro_self_logging_weekly";

  // Cooldown (7 days)
  const prior = await pg.query(
    `
    select last_sent_at
    from owner_nudges
    where owner_id = $1 and nudge_key = $2
    limit 1
    `,
    [String(owner_id).trim(), nudgeKey]
  );

  const last = prior?.rows?.[0]?.last_sent_at ? new Date(prior.rows[0].last_sent_at) : null;
  if (last && (Date.now() - last.getTime()) < 7 * 24 * 60 * 60 * 1000) return false;

  // Send the nudge
  const msg =
    "Heads up — your crew tried to clock in a few times this week.\n" +
    "Pro lets them log time directly from their phones.";

  try {
    await sendText(toPhone, msg);
  } catch {
    return false; // fail-open
  }

  // Record sent
  await pg.query(
    `
    insert into owner_nudges (owner_id, nudge_key, last_sent_at, meta)
    values ($1, $2, now(), $3)
    on conflict (owner_id, nudge_key)
    do update set last_sent_at = excluded.last_sent_at, meta = excluded.meta
    `,
    [String(owner_id).trim(), nudgeKey, JSON.stringify({ hits })]
  );

  return true;
}

module.exports = { maybeNudgeOwnerForProSelfLogging };
