// routes/crewControl.js
const express = require("express");
const pg = require("../services/postgres");
const { requireCrewControlPro } = require("../middleware/requireCrewControlPro");

const router = express.Router();

function mustCtx(req) {
  const tenantId = String(req.tenantId || "").trim();
  const ownerId = String(req.ownerId || "").trim();
  const actorId = String(req.actorId || "").trim();
  if (!tenantId || !ownerId || !actorId) {
    const err = new Error("Missing tenant/owner/actor context");
    err.code = "TENANT_CTX_MISSING";
    throw err;
  }
  return { tenantId, ownerId, actorId };
}

function jsonErr(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, code, message, ...extra });
}

async function getActorRole({ tenantId, actorId }, client) {
  const r = await client.query(
    `
    select role
      from public.chiefos_tenant_actors
     where tenant_id = $1
       and actor_id = $2   -- ✅ FIXED (was id)
     limit 1
    `,
    [tenantId, actorId]
  );
  return r?.rows?.[0]?.role || null;
}

function canOverrideInbox(role) {
  return role === "owner" || role === "admin";
}

/**
 * Append-only event writer (required on every mutation).
 */
async function insertEvent({ tenantId, ownerId, logId, eventType, actorId, payload }, client) {
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
    [tenantId, ownerId, logId, String(eventType), actorId, payload || {}]
  );
}

/**
 * Guard: log must belong to tenant; permission must be reviewer OR owner/admin.
 */
async function assertCanReview({ tenantId, actorId, logId }, client) {
  const r = await client.query(
    `
    select id, reviewer_actor_id
      from public.chiefos_activity_logs
     where tenant_id = $1
       and id = $2
     limit 1
    `,
    [tenantId, logId]
  );

  if (!r?.rowCount) {
    const err = new Error("Log not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  const reviewerActorId = r.rows[0].reviewer_actor_id;
  if (String(reviewerActorId || "") === String(actorId)) return { reviewerActorId };

  const role = await getActorRole({ tenantId, actorId }, client);
  if (!canOverrideInbox(role)) {
    const err = new Error("Permission denied");
    err.code = "PERMISSION_DENIED";
    throw err;
  }

  return { reviewerActorId, role };
}

/**
 * GET /api/crew/inbox
 * Returns pending logs for reviewer (board) or all pending for owner/admin.
 * ✅ JOIN fixed: chiefos_tenant_actors uses actor_id (not id).
 */
router.get("/inbox", requireCrewControlPro(), async (req, res) => {
  try {
    const { tenantId, actorId } = mustCtx(req);

    const out = await pg.withClient(async (client) => {
      const role = await getActorRole({ tenantId, actorId }, client);
      const isOwnerAdmin = canOverrideInbox(role);

      const q = isOwnerAdmin
        ? `
          select
            l.id,
            l.log_no,
            l.type,
            l.source,
            l.content_text,
            l.structured,
            l.status,
            l.created_at,
            l.created_by_actor_id,
            l.reviewer_actor_id,
            l.source_msg_id,
            a_creator.role as creator_role
          from public.chiefos_activity_logs l
          left join public.chiefos_tenant_actors a_creator
            on a_creator.tenant_id = l.tenant_id
           and a_creator.actor_id = l.created_by_actor_id  -- ✅ FIXED
          where l.tenant_id = $1
            and l.status in ('submitted','needs_clarification')
          order by l.created_at desc
          limit 200
        `
        : `
          select
            l.id,
            l.log_no,
            l.type,
            l.source,
            l.content_text,
            l.structured,
            l.status,
            l.created_at,
            l.created_by_actor_id,
            l.reviewer_actor_id,
            l.source_msg_id,
            a_creator.role as creator_role
          from public.chiefos_activity_logs l
          left join public.chiefos_tenant_actors a_creator
            on a_creator.tenant_id = l.tenant_id
           and a_creator.actor_id = l.created_by_actor_id  -- ✅ FIXED
          where l.tenant_id = $1
            and l.reviewer_actor_id = $2
            and l.status in ('submitted','needs_clarification')
          order by l.created_at desc
          limit 200
        `;

      const params = isOwnerAdmin ? [tenantId] : [tenantId, actorId];
      const r = await client.query(q, params);

      return { role, rows: r.rows || [] };
    });

    return res.json({ ok: true, role: out.role, items: out.rows });
  } catch (e) {
    console.error("[CREW_CONTROL] inbox error", {
      code: e?.code,
      message: e?.message,
      detail: e?.detail,
      hint: e?.hint,
      where: e?.where,
    });

    const code = e?.code || "INBOX_FAILED";
    const status = code === "TENANT_CTX_MISSING" ? 403 : 500;
    return jsonErr(res, status, code, "Unable to load crew inbox.");
  }
});

/**
 * POST /api/crew/logs/:id/approve
 */
router.post("/logs/:id/approve", requireCrewControlPro(), async (req, res) => {
  try {
    const { tenantId, ownerId, actorId } = mustCtx(req);
    const logId = String(req.params.id || "").trim();

    const out = await pg.withClient(async (client) => {
      await assertCanReview({ tenantId, actorId, logId }, client);

      // ✅ Never update by id alone. :contentReference[oaicite:16]{index=16}
      const u = await client.query(
        `
        update public.chiefos_activity_logs
           set status = 'approved',
               reviewed_by_actor_id = $1,
               reviewed_at = now(),
               updated_at = now()
         where tenant_id = $2
           and id = $3
           and status in ('submitted','needs_clarification')
         returning id, log_no, status
        `,
        [actorId, tenantId, logId]
      );

      if (!u?.rowCount) {
        const err = new Error("Log not in approvable state");
        err.code = "INVALID_STATE";
        throw err;
      }

      await insertEvent(
        {
          tenantId,
          ownerId,
          logId,
          eventType: "approved",
          actorId,
          payload: { status: "approved" },
        },
        client
      );

      return u.rows[0];
    });

    return res.json({ ok: true, log: out });
  } catch (e) {
    console.error("[CREW_CONTROL] approve error", e?.message || e);
    const code = e?.code || "APPROVE_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "NOT_FOUND" ? 404 :
      code === "INVALID_STATE" ? 409 : 500;
    return jsonErr(res, status, code, "Unable to approve this log.");
  }
});

/**
 * POST /api/crew/logs/:id/reject
 * Body: { reason?: string }
 */
router.post("/logs/:id/reject", requireCrewControlPro(), async (req, res) => {
  try {
    const { tenantId, ownerId, actorId } = mustCtx(req);
    const logId = String(req.params.id || "").trim();
    const reason = String(req.body?.reason || "").trim();

    const out = await pg.withClient(async (client) => {
      await assertCanReview({ tenantId, actorId, logId }, client);

            const u = await client.query(
        `
        update public.chiefos_activity_logs
           set status = 'rejected',
               reviewed_by_actor_id = $1,
               reviewed_at = now(),
               updated_at = now(),
               structured = coalesce(structured, '{}'::jsonb)
                 || jsonb_build_object('rejection_reason', $4::text)
         where tenant_id = $2
           and id = $3
           and status in ('submitted','needs_clarification')
         returning id, log_no, status
        `,
        [actorId, tenantId, logId, reason || null]
      );

      if (!u?.rowCount) {
        const err = new Error("Log not in rejectable state");
        err.code = "INVALID_STATE";
        throw err;
      }

      await insertEvent(
        {
          tenantId,
          ownerId,
          logId,
          eventType: "rejected",
          actorId,
          payload: { status: "rejected", reason: reason || null },
        },
        client
      );

      return u.rows[0];
    });

    return res.json({ ok: true, log: out });
  } catch (e) {
    console.error("[CREW_CONTROL] reject error", e?.message || e);
    const code = e?.code || "REJECT_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "NOT_FOUND" ? 404 :
      code === "INVALID_STATE" ? 409 : 500;
    return jsonErr(res, status, code, "Unable to reject this log.");
  }
});

/**
 * POST /api/crew/logs/:id/needs-clarification
 * Body: { note?: string }
 */
router.post("/logs/:id/needs-clarification", requireCrewControlPro(), async (req, res) => {
  try {
    const { tenantId, ownerId, actorId } = mustCtx(req);
    const logId = String(req.params.id || "").trim();
    const note = String(req.body?.note || "").trim();

    const out = await pg.withClient(async (client) => {
      await assertCanReview({ tenantId, actorId, logId }, client);

            const u = await client.query(
        `
        update public.chiefos_activity_logs
           set status = 'needs_clarification',
               reviewed_by_actor_id = $1,
               reviewed_at = now(),
               updated_at = now(),
               structured = coalesce(structured, '{}'::jsonb)
                 || jsonb_build_object('clarification_note', $4::text)
         where tenant_id = $2
           and id = $3
           and status in ('submitted','needs_clarification')
         returning id, log_no, status
        `,
        [actorId, tenantId, logId, note || null]
      );

      if (!u?.rowCount) {
        const err = new Error("Log not in clarification state");
        err.code = "INVALID_STATE";
        throw err;
      }

      await insertEvent(
        {
          tenantId,
          ownerId,
          logId,
          eventType: "needs_clarification",
          actorId,
          payload: { status: "needs_clarification", note: note || null },
        },
        client
      );

      return u.rows[0];
    });

    return res.json({ ok: true, log: out });
  } catch (e) {
    console.error("[CREW_CONTROL] needs-clarification error", e?.message || e);
    const code = e?.code || "CLARIFY_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "NOT_FOUND" ? 404 :
      code === "INVALID_STATE" ? 409 : 500;
    return jsonErr(res, status, code, "Unable to update this log.");
  }
});

module.exports = router;