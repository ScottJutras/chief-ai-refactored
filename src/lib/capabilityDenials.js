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
    // fail-open always
    console.warn("[capability_denial_log_failed]", e?.message || e);
  }
}

module.exports = { logCapabilityDenial };
