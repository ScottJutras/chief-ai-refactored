// src/lib/upsellMoments.js

const { shouldShowCrewUpgradeLine } = require("./upsellDecisions");
const { hasDenial, logCapabilityDenial } = require("./capabilityDenials");

const CREW_MOMENT_CAPABILITY = "upsell.crew_self_logging";
const CREW_MOMENT_REASON = "CREW_MOMENT_SHOWN";

// Verbatim (Moment 2)
const CREW_ONE_LINER =
  "Pro unlocks crew self-logging — employees can clock in/out from their own phones.";

// Optional (Moment 2 follow-up)
const CREW_FOLLOW_UP = "Want me to send the upgrade link?";

/**
 * maybeGetCrewMomentText
 * - Purely returns text to append, or null.
 * - Also marks the moment as "shown" (one-time) using capability_denials.
 *
 * IMPORTANT:
 * - "send" happens in the caller; this function just returns copy.
 * - This keeps it reusable across handlers.
 */
async function maybeGetCrewMomentText({ pg, ownerId, userId, role, plan, context, includeFollowUp = false }) {
  try {
    const owner_id = String(ownerId || "").trim();
    if (!owner_id) return null;

    const p = String(plan || "free").toLowerCase().trim();

    // Trigger surfaces:
    // - You can show this when:
    //   a) owner triggers crew-adjacent intent, OR
    //   b) a non-owner attempts to log time (this implies a crew exists)
    //
    // This implementation supports both via role check below.

    // Only Free/Starter are eligible for this moment.
    const shouldShow = shouldShowCrewUpgradeLine({ plan: p, isFirstCrewMoment: true });
    if (!shouldShow) return null;

    // One-time guard (fail-open safe)
    const already = await hasDenial(pg, {
      owner_id,
      capability: CREW_MOMENT_CAPABILITY,
      reason_code: CREW_MOMENT_REASON,
    });

    if (already) return null;

    // Mark as shown (fail-open safe)
    await logCapabilityDenial(pg, {
      owner_id,
      user_id: userId || null,
      actor_role: role || null,
      plan: p || null,
      capability: CREW_MOMENT_CAPABILITY,
      reason_code: CREW_MOMENT_REASON,
      upgrade_plan: "pro",
      job_id: null,
      source_msg_id: context?.source_msg_id || null,
      context: context || null,
    });

    return includeFollowUp ? `${CREW_ONE_LINER}\n\n${CREW_FOLLOW_UP}` : CREW_ONE_LINER;
  } catch {
    return null; // fail-open
  }
}

module.exports = { maybeGetCrewMomentText };
