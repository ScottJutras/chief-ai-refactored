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

// Centralize event types to match DB constraint.
// IMPORTANT: Your DB rejected 'edited'. Use 'edit' instead.
const EVENT = {
  APPROVED: "approved",
  REJECTED: "rejected",
  NEEDS_CLARIFICATION: "needs_clarification",
  EDIT: "edit", // <-- changed from 'edited' to 'edit'
};

/**
 * GET /api/crew/review/inbox
 */
router.get(
  "/review/inbox",
  requirePortalUser,
  requireCrewControlPro(),
  async (req, res) => {
    try {
      const { tenantId, actorId } = mustCtx(req);

      const items = await pg.withClient(
        async (client) => {
          const myRole = await getActorRole({ tenantId, actorId }, client);
          if (!myRole) return [];

          const r = await client.query(
            `
            select
              l.id,
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
        },
        { useTransaction: false }
      );

      return res.json({ ok: true, items });
    } catch (e) {
      const code = e?.code || "INBOX_FAILED";
      const status = code === "TENANT_CTX_MISSING" ? 403 : 500;
      console.error("[CREW_REVIEW] inbox error", e?.message || e);
      return jsonErr(res, status, code, "Unable to load inbox.");
    }
  }
);

/**
 * PATCH /api/crew/review/:logId
 */
router.patch(
  "/review/:logId",
  requirePortalUser,
  requireCrewControlPro(),
  express.json(),
  async (req, res) => {
    try {
      const { tenantId, actorId, ownerId } = mustCtx(req);
      const logId = String(req.params.logId || "").trim();

      const action = String(req.body?.action || "").trim().toLowerCase();

      const editedText = String(
        req.body?.edited_text ?? req.body?.content_text ?? ""
      ).trim();

      const notes = String(
        req.body?.notes ?? req.body?.note ?? req.body?.reason ?? ""
      ).trim();

      if (!logId) return jsonErr(res, 400, "MISSING_LOG", "Missing log id.");

      const allowed = ["approve", "reject", "edit", "needs_clarification"];
      if (!allowed.includes(action)) {
        return jsonErr(
          res,
          400,
          "INVALID_ACTION",
          "Action must be approve, reject, edit, or needs_clarification."
        );
      }

      if (action === "edit" && !editedText) {
        return jsonErr(res, 400, "MISSING_EDIT", "content_text is required for edit.");
      }

      if (action === "reject" && !notes) {
        return jsonErr(res, 400, "MISSING_REASON", "Reason is required for reject.");
      }

      if (action === "needs_clarification" && !notes) {
        return jsonErr(res, 400, "MISSING_NOTE", "note is required for needs clarification.");
      }

      const out = await pg.withClient(async (client) => {
        const myRole = await getActorRole({ tenantId, actorId }, client);
        const override = canOverrideReviewer(myRole);

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

        if (!override && String(log.reviewer_actor_id || "") !== String(actorId)) {
          const err = new Error("Permission denied");
          err.code = "PERMISSION_DENIED";
          throw err;
        }

        // Status transitions must be from submitted only
        if (action === "approve" || action === "reject" || action === "needs_clarification") {
          if (String(log.status || "") !== "submitted") {
            const err = new Error("Already processed");
            err.code = "STATUS_CONFLICT";
            throw err;
          }
        }

        const effectiveOwnerId = ownerId || log.owner_id;

        if (action === "approve") {
          const u = await client.query(
            `
            update public.chiefos_activity_logs
               set status = 'approved',
                   reviewed_by_actor_id = $3,
                   reviewed_at = now(),
                   updated_at = now()
             where tenant_id = $1
               and id = $2::uuid
               and status = 'submitted'
            returning id
            `,
            [tenantId, logId, actorId]
          );

          if ((u.rowCount || 0) === 0) {
            const err = new Error("Already processed");
            err.code = "STATUS_CONFLICT";
            throw err;
          }

          await client.query(
            `
            insert into public.chiefos_activity_log_events
              (tenant_id, owner_id, log_id, event_type, actor_id, payload)
            values
              ($1,$2,$3,$4,$5,$6)
            `,
            [
              tenantId,
              effectiveOwnerId,
              logId,
              EVENT.APPROVED,
              actorId,
              { notes: notes || null, prior_status: log.status },
            ]
          );

          return { id: logId, status: "approved" };
        }

        if (action === "reject") {
          const u = await client.query(
            `
            update public.chiefos_activity_logs
               set status = 'rejected',
                   reviewed_by_actor_id = $3,
                   reviewed_at = now(),
                   updated_at = now()
             where tenant_id = $1
               and id = $2::uuid
               and status = 'submitted'
            returning id
            `,
            [tenantId, logId, actorId]
          );

          if ((u.rowCount || 0) === 0) {
            const err = new Error("Already processed");
            err.code = "STATUS_CONFLICT";
            throw err;
          }

          await client.query(
            `
            insert into public.chiefos_activity_log_events
              (tenant_id, owner_id, log_id, event_type, actor_id, payload)
            values
              ($1,$2,$3,$4,$5,$6)
            `,
            [
              tenantId,
              effectiveOwnerId,
              logId,
              EVENT.REJECTED,
              actorId,
              { reason: notes, prior_status: log.status },
            ]
          );

          return { id: logId, status: "rejected" };
        }

        if (action === "needs_clarification") {
          const u = await client.query(
            `
            update public.chiefos_activity_logs
               set status = 'needs_clarification',
                   reviewed_by_actor_id = $3,
                   reviewed_at = now(),
                   updated_at = now()
             where tenant_id = $1
               and id = $2::uuid
               and status = 'submitted'
            returning id
            `,
            [tenantId, logId, actorId]
          );

          if ((u.rowCount || 0) === 0) {
            const err = new Error("Already processed");
            err.code = "STATUS_CONFLICT";
            throw err;
          }

          await client.query(
            `
            insert into public.chiefos_activity_log_events
              (tenant_id, owner_id, log_id, event_type, actor_id, payload)
            values
              ($1,$2,$3,$4,$5,$6)
            `,
            [
              tenantId,
              effectiveOwnerId,
              logId,
              EVENT.NEEDS_CLARIFICATION,
              actorId,
              { note: notes, prior_status: log.status },
            ]
          );

          return { id: logId, status: "needs_clarification" };
        }

        // action === "edit"
        const prior = String(log.content_text || "");

        await client.query(
          `
          update public.chiefos_activity_logs
             set content_text = $3,
                 updated_at = now()
           where tenant_id = $1
             and id = $2::uuid
          `,
          [tenantId, logId, editedText]
        );

        await client.query(
          `
          insert into public.chiefos_activity_log_events
            (tenant_id, owner_id, log_id, event_type, actor_id, payload)
          values
            ($1,$2,$3,$4,$5,$6)
          `,
          [
            tenantId,
            effectiveOwnerId,
            logId,
            EVENT.EDIT, // <-- now 'edit' (passes your constraint)
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
        code === "STATUS_CONFLICT" ? 409 :
        500;

      console.error("[CREW_REVIEW] action error", e?.message || e);
      return jsonErr(res, status, code, "Unable to update log.");
    }
  }
);

module.exports = router;