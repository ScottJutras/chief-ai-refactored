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

  const tid = String(tenantId).trim();
  const oid = String(ownerId).trim();

  // ✅ One transaction so: allocate log_no + insert log + insert event is consistent
  return await pg.withClient(async (client) => {
    // Lock per-tenant so numbering is sequential and collision-free
    if (typeof pg.withTenantAllocLock === "function") {
      await pg.withTenantAllocLock(tid, client);
    }

    // If idempotent key exists, return existing row (and its log_no) instead of updating
    if (sourceMsgId) {
      const existing = await client.query(
        `
        select id, log_no
          from public.chiefos_activity_logs
         where tenant_id = $1
           and source_msg_id = $2
         limit 1
        `,
        [tid, String(sourceMsgId)]
      );
      if (existing?.rowCount) {
        return { ok: true, logId: existing.rows[0].id, logNo: existing.rows[0].log_no, reviewerActorId: reviewerFinal };
      }
    }

    // Allocate a new per-tenant log number (preferred)
    let logNo = null;
    if (typeof pg.allocateNextActivityLogNo === "function") {
      logNo = await pg.allocateNextActivityLogNo(tid, client);
    } else {
      // fallback: derive from existing rows (not ideal, but keeps it alive)
      const r = await client.query(
        `select coalesce(max(log_no), 0)::int + 1 as next_no
           from public.chiefos_activity_logs
          where tenant_id=$1`,
        [tid]
      );
      logNo = Number(r?.rows?.[0]?.next_no || 1);
    }

    // Insert log
    const ins = await client.query(
      `
      insert into public.chiefos_activity_logs (
        tenant_id,
        owner_id,
        log_no,
        created_by_actor_id,
        reviewer_actor_id,
        type,
        source,
        content_text,
        structured,
        status,
        source_msg_id
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      returning id, log_no
      `,
      [
        tid,
        oid,
        logNo,
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

    const logId = ins?.rows?.[0]?.id || null;
    const logNoOut = ins?.rows?.[0]?.log_no ?? logNo;

    if (!logId) throw new Error("Failed to create crew activity log");

    // event (append-only)
    await client.query(
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
        tid,
        oid,
        logId,
        "created",
        createdByActorId,
        {
          type,
          source,
          status,
          reviewer_actor_id: reviewerFinal,
          source_msg_id: sourceMsgId || null,
          log_no: logNoOut || null,
        },
      ]
    );

    return { ok: true, logId, logNo: logNoOut, reviewerActorId: reviewerFinal };
  });
}

module.exports = {
  resolveReviewerActorId,
  createCrewActivityLog,
};