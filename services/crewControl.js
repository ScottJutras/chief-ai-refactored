// services/crewControl.js
const pg = require("./postgres");
const { COUNTER_KINDS } = require("../src/cil/counterKinds");

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
 * Repair counter drift by bumping next_activity_log_no = max(log_no)+1
 * Safe to run any time.
 */
async function bumpTenantCounterToMax(tenantId) {
  const tid = String(tenantId || "").trim();
  if (!tid) return;

  try {
    // Correctness fix for Migration 5: counter_kind predicate is load-bearing
    // under the composite PK. Without it this UPDATE would smash every counter
    // kind for the tenant with the activity_log max. See docs/QUOTES_SPINE_DECISIONS.md §18.4.
    await pg.query(
      `
      update public.chiefos_tenant_counters c
      set next_no = x.next_no,
          updated_at = now()
      from (
        select (coalesce(max(log_no), 0) + 1)::int as next_no
        from public.chiefos_activity_logs
        where tenant_id = $1
      ) x
      where c.tenant_id = $1::uuid and c.counter_kind = 'activity_log'
      `,
      [tid]
    );
  } catch (e) {
    console.warn("[CREW_CONTROL] bumpTenantCounterToMax failed (ignored):", e?.message || e);
  }
}

/**
 * Create a Crew activity log + an append-only event.
 * Idempotent per (tenant_id, source_msg_id) if source_msg_id is provided.
 *
 * Returns:
 *  { ok: true, logId, logNo, reviewerActorId, deduped }
 */
async function createCrewActivityLog({
  tenantId,
  ownerId,
  createdByActorId,
  type, // 'time' | 'task'
  source, // 'whatsapp' | 'portal' | ...
  contentText,
  structured = {},
  status = "submitted",
  sourceMsgId = null,
} = {}) {
  // ---- Required validation ----
  const tid = String(tenantId || "").trim();
  const oid = String(ownerId || "").trim();
  const by = String(createdByActorId || "").trim();
  const t = String(type || "").trim();
  const s = String(source || "").trim();
  const rawText = String(contentText || "").trim();

  if (!tid) throw new Error("Missing tenantId");
  if (!oid) throw new Error("Missing ownerId");
  if (!by) throw new Error("Missing createdByActorId");
  if (!t) throw new Error("Missing type");
  if (!s) throw new Error("Missing source");
  if (!rawText) throw new Error("Missing contentText");

  // reviewer (board assignment -> owner/admin -> null)
  let reviewerActorId = null;
  try {
    reviewerActorId = await resolveReviewerActorId({
      tenantId: tid,
      creatorActorId: by,
    });
  } catch (e) {
    console.warn("[CREW_CONTROL] resolveReviewerActorId failed:", e?.message || e);
    reviewerActorId = null;
  }

  // ✅ fallback to self-review (prevents capture from breaking in half-configured tenants)
  const reviewerFinal = reviewerActorId || by;
  if (!reviewerActorId) {
    console.warn("[CREW_CONTROL] reviewer fallback to self", { tenantId: tid, createdByActorId: by });
  }

  const msgId = sourceMsgId ? String(sourceMsgId).trim() : null;

  // ✅ CLEAN stored content (no "Task " prefix)
  let cleanText = rawText;
  if (t === "task") {
    cleanText = cleanText
      .replace(/^\s*task\s*-\s*/i, "")
      .replace(/^\s*task-\s*/i, "")
      .replace(/^\s*task\s+/i, "")
      .trim();
  }
  if (!cleanText) throw new Error("Missing contentText");

  const tryOnce = async () => {
    return await pg.withClient(async (client) => {
      // Ensure per-tenant allocation lock (single-flight allocator)
      if (typeof pg.withTenantAllocLock === "function") {
        await pg.withTenantAllocLock(tid, client);
      }

      // ✅ Idempotency pre-check (fast)
      if (msgId) {
        const existing = await client.query(
          `
          select id, log_no
            from public.chiefos_activity_logs
           where tenant_id = $1
             and source_msg_id = $2
           limit 1
          `,
          [tid, msgId]
        );

        if (existing?.rowCount) {
          return {
            ok: true,
            logId: existing.rows[0].id,
            logNo: existing.rows[0].log_no,
            reviewerActorId: reviewerFinal,
            deduped: true,
          };
        }
      }

      // ✅ Allocate log_no (must exist in postgres.js)
      const logNo = await pg.allocateNextDocCounter(tid, COUNTER_KINDS.ACTIVITY_LOG, client);

      let ins;

      if (msgId) {
        // ✅ Idempotent path (predicate matches your partial unique index exactly)
        ins = await client.query(
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
          on conflict (tenant_id, source_msg_id)
          where (source_msg_id is not null)
          do update set updated_at = now()
          returning id, log_no
          `,
          [
            tid,
            oid,
            logNo,
            by,
            reviewerFinal,
            t,
            s,
            cleanText,
            structured || {},
            String(status || "submitted"),
            msgId,
          ]
        );
      } else {
        // ✅ Non-idempotent path (no source_msg_id)
        ins = await client.query(
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
            by,
            reviewerFinal,
            t,
            s,
            cleanText,
            structured || {},
            String(status || "submitted"),
            null,
          ]
        );
      }

      const logId = ins?.rows?.[0]?.id || null;
      const logNoOut = ins?.rows?.[0]?.log_no ?? logNo;
      if (!logId) throw new Error("Failed to create crew activity log");

      // ✅ event (append-only)
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
          by,
          {
            type: t,
            source: s,
            status: String(status || "submitted"),
            reviewer_actor_id: reviewerFinal,
            source_msg_id: msgId,
            log_no: logNoOut,
          },
        ]
      );

      return { ok: true, logId, logNo: logNoOut, reviewerActorId: reviewerFinal, deduped: false };
    });
  };

  // ✅ retry once if log_no collided (counter drift)
  try {
    return await tryOnce();
  } catch (e) {
    const code = String(e?.code || "");
    const msg = String(e?.message || "");
    const isLogNoCollision =
      code === "23505" && /ux_activity_logs_tenant_log_no/i.test(msg);

    if (!isLogNoCollision) throw e;

    console.warn("[CREW_CONTROL] log_no collision → repairing counter and retrying", {
      tenantId: tid,
      sourceMsgId: msgId,
    });

    await bumpTenantCounterToMax(tid);
    return await tryOnce();
  }
}

module.exports = {
  resolveReviewerActorId,
  createCrewActivityLog,
};