// routes/crewReview.js
const express = require("express");
const pg = require("../services/postgres");
const { requireCrewControlPro } = require("../middleware/requireCrewControlPro");
const { requirePortalUser } = require("../middleware/requirePortalUser");

const router = express.Router();

function jsonErr(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, code, message, ...extra });
}

function mustCtx(req) {
  const tenantId = String(req.tenantId || "").trim();
  const actorId = String(req.actorId || "").trim();
  const ownerId = String(req.ownerId || "").trim();

  if (!tenantId || !actorId) {
    const err = new Error("Access not resolved. Please re-authenticate.");
    err.code = "TENANT_CTX_MISSING";
    throw err;
  }

  return { tenantId, actorId, ownerId };
}

async function getActorRole({ tenantId, actorId }, client) {
  const r = await client.query(
    `
    select role
      from public.chiefos_tenant_actors
     where tenant_id = $1
       and actor_id = $2
     limit 1
    `,
    [tenantId, actorId]
  );
  return r?.rows?.[0]?.role || null;
}

function canOverrideReviewer(role) {
  return role === "owner" || role === "admin";
}

/**
 * GET /api/crew/review/inbox
 * Reviewer queue:
 * - reviewer_actor_id = me (board/admin/owner)
 * - status = submitted
 */
router.get("/review/inbox", requirePortalUser, requireCrewControlPro(), async (req, res) => {
  try {
    const { tenantId, actorId } = mustCtx(req);

    const items = await pg.withClient(async (client) => {
      const myRole = await getActorRole({ tenantId, actorId }, client);
      if (!myRole) return [];

      const r = await client.query(
        `
        select
          l.id,
          l.tenant_id,
          l.owner_id,
          l.log_no,
          l.type,
          l.source,
          l.content_text,
          l.structured,
          l.status,
          l.source_msg_id,
          l.created_by_actor_id,
          l.reviewer_actor_id,
          l.created_at,
          l.updated_at,
          p.display_name as created_by_name
        from public.chiefos_activity_logs l
        left join public.chiefos_tenant_actor_profiles p
          on p.tenant_id = l.tenant_id
         and p.actor_id = l.created_by_actor_id
        where l.tenant_id = $1
          and l.status = 'submitted'
          and l.reviewer_actor_id = $2
        order by l.created_at desc
        limit 200
        `,
        [tenantId, actorId]
      );

      return r.rows || [];
    });

    return res.json({ ok: true, items });
  } catch (e) {
    const code = e?.code || "INBOX_FAILED";
    const status = code === "TENANT_CTX_MISSING" ? 403 : 500;
    console.error("[CREW_REVIEW] inbox error", e?.message || e);
    return jsonErr(res, status, code, "Unable to load inbox.");
  }
});

/**
 * PATCH /api/crew/review/:logId
 * Body:
 *  { action: 'approve'|'reject'|'edit', edited_text?, notes? }
 *
 * Rules:
 * - reviewer can act on their assigned logs
 * - owner/admin can act on any log in tenant (override)
 * - edit updates content_text + writes an audit event
 * - approve/reject sets status + writes event
 */
router.patch("/review/:logId", requirePortalUser, requireCrewControlPro(), express.json(), async (req, res) => {
  try {
    const { tenantId, actorId, ownerId } = mustCtx(req);
    const logId = String(req.params.logId || "").trim();

    const action = String(req.body?.action || "").trim().toLowerCase();
    const editedText = String(req.body?.edited_text || "").trim();
    const notes = String(req.body?.notes || "").trim();

    if (!logId) return jsonErr(res, 400, "MISSING_LOG", "Missing log id.");
    if (!["approve", "reject", "edit"].includes(action)) {
      return jsonErr(res, 400, "INVALID_ACTION", "Action must be approve, reject, or edit.");
    }
    if (action === "edit" && !editedText) {
      return jsonErr(res, 400, "MISSING_EDIT", "edited_text is required for edit.");
    }

    const out = await pg.withClient(async (client) => {
      const myRole = await getActorRole({ tenantId, actorId }, client);
      const override = canOverrideReviewer(myRole);

      // Load target log
      const r = await client.query(
        `
        select
          id,
          tenant_id,
          owner_id,
          log_no,
          status,
          content_text,
          created_by_actor_id,
          reviewer_actor_id,
          type,
          source,
          structured,
          source_msg_id
        from public.chiefos_activity_logs
        where tenant_id = $1
          and id = $2::uuid
        limit 1
        `,
        [tenantId, logId]
      );

      const log = r?.rows?.[0] || null;
      if (!log) {
        const err = new Error("Not found");
        err.code = "NOT_FOUND";
        throw err;
      }

      // Permission: must be reviewer OR override (owner/admin)
      if (!override && String(log.reviewer_actor_id || "") !== String(actorId)) {
        const err = new Error("Permission denied");
        err.code = "PERMISSION_DENIED";
        throw err;
      }

      // Status transitions
      if (action === "approve") {
        await client.query(
          `
          update public.chiefos_activity_logs
             set status = 'approved',
                 reviewed_by_actor_id = $3,
                 reviewed_at = now(),
                 updated_at = now()
           where tenant_id = $1 and id = $2::uuid
          `,
          [tenantId, logId, actorId]
        );

        await client.query(
          `
          insert into public.chiefos_activity_log_events
            (tenant_id, owner_id, log_id, event_type, actor_id, payload)
          values
            ($1,$2,$3,'approved',$4,$5)
          `,
          [
            tenantId,
            ownerId || log.owner_id,
            logId,
            actorId,
            {
              notes: notes || null,
              prior_status: log.status,
            },
          ]
        );

        return { id: logId, status: "approved" };
      }

      if (action === "reject") {
        await client.query(
          `
          update public.chiefos_activity_logs
             set status = 'rejected',
                 reviewed_by_actor_id = $3,
                 reviewed_at = now(),
                 updated_at = now()
           where tenant_id = $1 and id = $2::uuid
          `,
          [tenantId, logId, actorId]
        );

        await client.query(
          `
          insert into public.chiefos_activity_log_events
            (tenant_id, owner_id, log_id, event_type, actor_id, payload)
          values
            ($1,$2,$3,'rejected',$4,$5)
          `,
          [
            tenantId,
            ownerId || log.owner_id,
            logId,
            actorId,
            {
              notes: notes || null,
              prior_status: log.status,
            },
          ]
        );

        return { id: logId, status: "rejected" };
      }

      // action === "edit"
      const prior = String(log.content_text || "");
      await client.query(
        `
        update public.chiefos_activity_logs
           set content_text = $3,
               updated_at = now()
         where tenant_id = $1 and id = $2::uuid
        `,
        [tenantId, logId, editedText]
      );

      await client.query(
        `
        insert into public.chiefos_activity_log_events
          (tenant_id, owner_id, log_id, event_type, actor_id, payload)
        values
          ($1,$2,$3,'edited',$4,$5)
        `,
        [
          tenantId,
          ownerId || log.owner_id,
          logId,
          actorId,
          {
            prior_text: prior,
            edited_text: editedText,
            notes: notes || null,
          },
        ]
      );

      return { id: logId, status: String(log.status || "submitted"), edited: true };
    });

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "REVIEW_ACTION_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "NOT_FOUND" ? 404 :
      500;

    console.error("[CREW_REVIEW] action error", e?.message || e);
    return jsonErr(res, status, code, "Unable to update log.");
  }
});

module.exports = router;