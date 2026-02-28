// services/crewControl.js
const pg = require("./postgres");

/**
 * Resolve reviewer for a log:
 * 1) If creator is employee and has active board assignment → board_actor_id
 * 2) Else fallback to tenant owner/admin actor (prefer owner)
 */
async function resolveReviewerActorId({ tenantId, creatorActorId }) {
  // 1) board assignment
  const a = await pg.query(
    `
    select board_actor_id
      from public.chiefos_board_assignments
     where tenant_id = $1
       and employee_actor_id = $2
       and active = true
     limit 1
    `,
    [tenantId, creatorActorId]
  );

  const board = a?.rows?.[0]?.board_actor_id || null;
  if (board) return board;

  // 2) owner/admin fallback
  const b = await pg.query(
    `
    select actor_id, role
      from public.chiefos_tenant_actors
     where tenant_id = $1
       and role in ('owner','admin')
     order by case role when 'owner' then 0 else 1 end
     limit 1
    `,
    [tenantId]
  );

  return b?.rows?.[0]?.actor_id || null;
}

/**
 * Create a Crew activity log + an append-only event.
 * Idempotent per (tenant_id, source_msg_id) if source_msg_id is provided.
 */
async function createCrewActivityLog({
  tenantId,
  ownerId,
  createdByActorId,
  type,            // 'time' | 'task'
  source,          // 'whatsapp' | 'portal' | ...
  contentText,
  structured = {},
  status = "submitted",
  sourceMsgId = null,
}) {
  if (!tenantId) throw new Error("Missing tenantId");
  if (!ownerId) throw new Error("Missing ownerId");
  if (!createdByActorId) throw new Error("Missing createdByActorId");
  if (!type) throw new Error("Missing type");
  if (!source) throw new Error("Missing source");
  if (!String(contentText || "").trim()) throw new Error("Missing contentText");

  // reviewer (board assignment -> owner/admin -> null)
  let reviewerActorId = null;
  try {
    reviewerActorId = await resolveReviewerActorId({
      tenantId,
      creatorActorId: createdByActorId,
    });
  } catch (e) {
    console.warn("[CREW_CONTROL] resolveReviewerActorId failed:", e?.message);
    reviewerActorId = null;
  }

  // ✅ fallback to self-review (prevents capture from breaking in half-configured tenants)
  const reviewerFinal = reviewerActorId || createdByActorId;
  if (!reviewerActorId) {
    console.warn("[CREW_CONTROL] reviewer fallback to self", { tenantId, createdByActorId });
  }

  const inserted = await pg.query(
    `
    insert into public.chiefos_activity_logs (
      tenant_id,
      owner_id,
      created_by_actor_id,
      reviewer_actor_id,
      type,
      source,
      content_text,
      structured,
      status,
      source_msg_id
    )
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    on conflict (tenant_id, source_msg_id)
    where source_msg_id is not null
    do update set updated_at = now()
    returning id
    `,
    [
      tenantId,
      String(ownerId),
      createdByActorId,
      reviewerFinal,
      String(type),
      String(source),
      String(contentText).trim(),
      structured || {},
      String(status),
      sourceMsgId ? String(sourceMsgId) : null,
    ]
  );

  const logId = inserted?.rows?.[0]?.id || null;
  if (!logId) throw new Error("Failed to create crew activity log");

  // event (append-only)
  await pg.query(
    `
    insert into public.chiefos_activity_log_events (
      tenant_id,
      owner_id,
      log_id,
      event_type,
      actor_id,
      payload
    )
    values ($1,$2,$3,$4,$5,$6)
    `,
    [
      tenantId,
      String(ownerId),
      logId,
      "created",
      createdByActorId,
      {
        type,
        source,
        status,
        reviewer_actor_id: reviewerFinal,
        source_msg_id: sourceMsgId || null,
      },
    ]
  );

  return { ok: true, logId, reviewerActorId: reviewerFinal };
}

module.exports = {
  resolveReviewerActorId,
  createCrewActivityLog,
};