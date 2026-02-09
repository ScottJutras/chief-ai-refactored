// src/lib/capabilityDenials.js

async function logCapabilityDenial(db, row) {
  try {
    if (!db || typeof db.query !== "function") return; // fail-open

    const {
      owner_id,
      user_id = null,
      actor_role = null,
      plan = null,
      capability = null,
      reason_code,
      upgrade_plan = null,
      job_id = null,
      source_msg_id = null,
      context = null,
    } = row || {};

    if (!owner_id || !reason_code) return; // fail-open

    await db.query(
      `
      insert into capability_denials
        (owner_id, user_id, actor_role, plan, capability, reason_code, upgrade_plan, job_id, source_msg_id, context)
      values
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `,
      [
        owner_id,
        user_id,
        actor_role,
        plan,
        capability,
        reason_code,
        upgrade_plan,
        job_id,
        source_msg_id,
        context ? JSON.stringify(context) : null,
      ]
    );
  } catch (e) {
    console.warn("[capability_denial_log_failed]", e?.message || e);
  }
}

/**
 * ✅ One-time guard helper (fail-open).
 * Returns true if a matching denial row exists.
 */
async function hasDenial(db, { owner_id, capability, reason_code } = {}) {
  try {
    if (!db || typeof db.query !== "function") return false; // fail-open
    if (!owner_id) return false;

    const cap = capability != null ? String(capability) : null;
    const code = reason_code != null ? String(reason_code) : null;

    const { rows } = await db.query(
      `
      select 1
        from capability_denials
       where owner_id = $1
         and ($2::text is null or capability = $2::text)
         and ($3::text is null or reason_code = $3::text)
       limit 1
      `,
      [String(owner_id), cap, code]
    );

    return !!rows?.length;
  } catch (e) {
    // fail-open
    return false;
  }
}

module.exports = { logCapabilityDenial, hasDenial };
