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

// Roles that see the full tenant review queue regardless of
// per-log reviewer assignment. Board members get full visibility
// now too, but they cannot act on items created/submitted by the
// owner — enforced at each action site below.
function canOverrideReviewer(role) {
  return role === "owner" || role === "admin" || role === "board";
}

// Look up the tenant owner's actor_id once per request — used to
// exclude owner-created items from board reviewers.
async function getOwnerActorId(tenantId, client) {
  if (!tenantId) return null;
  const r = await client.query(
    `select actor_id
       from public.chiefos_tenant_actors
      where tenant_id = $1 and role = 'owner'
      order by created_at asc
      limit 1`,
    [tenantId]
  );
  return r?.rows?.[0]?.actor_id || null;
}

// Must match DB CHECK constraint allowed values
const EVENT = {
  CREATED: "created",
  APPROVED: "approved",
  REJECTED: "rejected",
  NEEDS_CLARIFICATION: "needs_clarification",
  EDITED: "edited",
};

// --- WhatsApp notify helpers (fail-soft) ---
function getTwilioClientOrNull() {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const token = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!sid || !token) return null;
  try {
    // eslint-disable-next-line global-require
    const twilio = require("twilio");
    return twilio(sid, token);
  } catch {
    return null;
  }
}

function getWhatsAppFromOrNull() {
  const from = String(process.env.TWILIO_WHATSAPP_FROM || "").trim();
  if (!from) return null;
  // allow either "+1..." or "whatsapp:+1..."
  return from.toLowerCase().startsWith("whatsapp:") ? from : `whatsapp:${from}`;
}

async function lookupCreatorWhatsAppTo({ tenantId, createdByActorId }, client) {
  // Prefer whatsapp:+E164 variants if present (we insert multiple forms)
  const r = await client.query(
    `
    select identifier
      from public.chiefos_actor_identities
     where kind = 'whatsapp'
       and actor_id = $1
     order by
       case
         when identifier like 'whatsapp:+%' then 0
         when identifier like 'whatsapp:%' then 1
         when identifier like '+%' then 2
         else 3
       end,
       length(identifier) desc
     limit 1
    `,
    [createdByActorId]
  );

  const id = r?.rows?.[0]?.identifier ? String(r.rows[0].identifier) : "";
  if (!id) return null;

  const to = id.toLowerCase().startsWith("whatsapp:") ? id : `whatsapp:${id}`;
  return to;
}

async function notifyCreatorWhatsApp({ tenantId, createdByActorId, text }, client) {
  const tw = getTwilioClientOrNull();
  const from = getWhatsAppFromOrNull();
  if (!tw || !from) {
    console.info("[CREW_REVIEW_NOTIFY] skipped (missing twilio env)");
    return { ok: false, skipped: true };
  }

  const to = await lookupCreatorWhatsAppTo({ tenantId, createdByActorId }, client);
  if (!to) {
    console.info("[CREW_REVIEW_NOTIFY] skipped (no whatsapp identity)");
    return { ok: false, skipped: true };
  }

  await tw.messages.create({ from, to, body: String(text || "").trim() });
  return { ok: true };
}

/**
 * GET /api/crew/review/inbox
 */
router.get("/review/inbox", requirePortalUser(), requireCrewControlPro(), async (req, res) => {
  try {
    const { tenantId, actorId } = mustCtx(req);

    const items = await pg.withClient(
      async (client) => {
        const myRole = await getActorRole({ tenantId, actorId }, client);
        if (!myRole) return [];

        const override = canOverrideReviewer(myRole);

        // Board sees the full queue EXCEPT logs created by the owner.
        // Owner/admin see the full queue. Anyone else falls back to
        // only the logs where they're the assigned reviewer.
        let whereExtra = "and l.reviewer_actor_id = $2";
        const params = [tenantId, actorId];

        if (override) {
          whereExtra = "";
          params.length = 1; // just tenantId

          if (myRole === "board") {
            const ownerActorId = await getOwnerActorId(tenantId, client);
            if (ownerActorId) {
              whereExtra = "and l.created_by_actor_id <> $2";
              params.push(ownerActorId);
            }
          }
        }

        const sql = `
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
            ${whereExtra}
          order by l.created_at desc
          limit 200
        `;
        const r = await client.query(sql, params);
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
});

/**
 * PATCH /api/crew/review/:logId
 *
 * Accepts UI payload keys:
 * - action: 'approve'|'reject'|'edit'|'needs_clarification'
 * - edit text: edited_text OR content_text
 * - notes: notes OR note OR reason
 */
router.patch("/review/:logId", requirePortalUser(), requireCrewControlPro(), express.json(), async (req, res) => {
  try {
    const { tenantId, actorId, ownerId } = mustCtx(req);
    const logId = String(req.params.logId || "").trim();

    const action = String(req.body?.action || "").trim().toLowerCase();
    const editedText = String(req.body?.edited_text ?? req.body?.content_text ?? "").trim();
    const notes = String(req.body?.notes ?? req.body?.note ?? req.body?.reason ?? "").trim();

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

    let notifyPayload = null;

    const out = await pg.withClient(async (client) => {
      const myRole = await getActorRole({ tenantId, actorId }, client);
      const override = canOverrideReviewer(myRole);

      // Load log inside tenant boundary (include creator for notifications)
      const r = await client.query(
        `
        select
          id,
          tenant_id,
          owner_id,
          log_no,
          status,
          content_text,
          reviewer_actor_id,
          created_by_actor_id
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

      // Permission: must be reviewer OR override
      if (!override && String(log.reviewer_actor_id || "") !== String(actorId)) {
        const err = new Error("Permission denied");
        err.code = "PERMISSION_DENIED";
        throw err;
      }

      // Board members cannot review items created by the owner.
      if (myRole === "board") {
        const ownerActorId = await getOwnerActorId(tenantId, client);
        if (ownerActorId && String(log.created_by_actor_id || "") === String(ownerActorId)) {
          const err = new Error("Board members cannot review the owner's activity.");
          err.code = "PERMISSION_DENIED";
          throw err;
        }
      }

      // Guard status transitions to prevent races
      const isTransition = action === "approve" || action === "reject" || action === "needs_clarification";
      if (isTransition && String(log.status || "") !== "submitted") {
        const err = new Error("Already processed");
        err.code = "STATUS_CONFLICT";
        throw err;
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
          [tenantId, effectiveOwnerId, logId, EVENT.APPROVED, actorId, { notes: notes || null, prior_status: log.status }]
        );

        notifyPayload = {
          createdByActorId: log.created_by_actor_id,
          text: `✅ Approved (#${log.log_no}): ${String(log.content_text || "").trim()}`,
        };

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
          [tenantId, effectiveOwnerId, logId, EVENT.REJECTED, actorId, { reason: notes, prior_status: log.status }]
        );

        notifyPayload = {
          createdByActorId: log.created_by_actor_id,
          text: `❌ Rejected (#${log.log_no}): ${String(log.content_text || "").trim()}\nReason: ${notes}`,
        };

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
          [tenantId, effectiveOwnerId, logId, EVENT.NEEDS_CLARIFICATION, actorId, { note: notes, prior_status: log.status }]
        );

        notifyPayload = {
          createdByActorId: log.created_by_actor_id,
          text: `❓ Needs clarification (#${log.log_no}): ${notes}`,
        };

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
          EVENT.EDITED,
          actorId,
          {
            prior_text: prior,
            edited_text: editedText,
            notes: notes || null,
          },
        ]
      );

      notifyPayload = {
        createdByActorId: log.created_by_actor_id,
        text: `✏️ Updated (#${log.log_no}): ${editedText}`,
      };

      return { id: logId, status: String(log.status || "submitted"), edited: true };
    });

    // Send WhatsApp notification fail-soft (never break the review action)
    try {
      if (notifyPayload?.createdByActorId && notifyPayload?.text) {
        await pg.withClient(
          async (client) => {
            await notifyCreatorWhatsApp(
              {
                tenantId,
                createdByActorId: notifyPayload.createdByActorId,
                text: notifyPayload.text,
              },
              client
            );
          },
          { useTransaction: false }
        );
      }
    } catch (e) {
      console.warn("[CREW_REVIEW_NOTIFY] failed (ignored):", e?.message || e);
    }

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
});

/**
 * GET /api/crew/review/expenses/pending
 * Owner/admin/board: list transactions with submission_status = 'pending_review'.
 */
router.get("/review/expenses/pending", requirePortalUser(), requireCrewControlPro(), async (req, res) => {
  try {
    const { tenantId, actorId, ownerId } = mustCtx(req);

    const out = await pg.withClient(async (client) => {
      const role = await getActorRole({ tenantId, actorId }, client);
      if (!["owner", "admin", "board"].includes(role)) {
        const err = new Error("Permission denied");
        err.code = "PERMISSION_DENIED";
        throw err;
      }

      // Board members do not see submissions made BY the owner.
      // submitted_by stores the submitter's phone digits (paUserId),
      // and ownerId is the owner's phone digits, so a string compare
      // is the right exclusion.
      const excludeOwnerSubmissions = role === "board";
      const sql = `
        SELECT
          t.id,
          t.kind,
          t.amount_cents,
          t.description,
          t.vendor,
          t.category,
          t.job_no,
          t.occurred_at,
          t.submitted_by,
          t.submission_status,
          t.reviewer_note,
          t.created_at
        FROM public.transactions t
        WHERE t.owner_id = $1
          AND t.submission_status = 'pending_review'
          AND t.kind IN ('expense', 'revenue')
          ${excludeOwnerSubmissions ? "AND (t.submitted_by IS NULL OR t.submitted_by <> $2)" : ""}
        ORDER BY t.created_at DESC
        LIMIT 100
      `;
      const params = excludeOwnerSubmissions ? [ownerId, ownerId] : [ownerId];

      const r = await client.query(sql, params);
      return r.rows || [];
    });

    return res.json({ ok: true, items: out });
  } catch (e) {
    const code = e?.code || "PENDING_EXPENSES_FAILED";
    const status = code === "TENANT_CTX_MISSING" ? 403 : code === "PERMISSION_DENIED" ? 403 : 500;
    console.error("[CREW_REVIEW_EXPENSES] list error", e?.message || e);
    return jsonErr(res, status, code, "Unable to load pending submissions.");
  }
});

/**
 * PATCH /api/crew/review/expenses/:id
 * Body: { action: 'approve' | 'decline', reviewer_note? }
 * Updates submission_status on the transaction.
 */
router.patch("/review/expenses/:id", requirePortalUser(), requireCrewControlPro(), express.json(), async (req, res) => {
  try {
    const { tenantId, actorId, ownerId } = mustCtx(req);
    const txId = String(req.params.id || "").trim();
    const action = String(req.body?.action || "").trim();
    const reviewerNote = String(req.body?.reviewer_note || "").trim() || null;

    if (!txId) return jsonErr(res, 400, "MISSING_ID", "Transaction ID required.");
    if (!["approve", "decline"].includes(action)) return jsonErr(res, 400, "INVALID_ACTION", "Action must be approve or decline.");

    const newStatus = action === "approve" ? "confirmed" : "declined";

    const out = await pg.withClient(async (client) => {
      const role = await getActorRole({ tenantId, actorId }, client);
      if (!["owner", "admin", "board"].includes(role)) {
        const err = new Error("Permission denied");
        err.code = "PERMISSION_DENIED";
        throw err;
      }

      // Board members cannot act on transactions submitted by the
      // owner. Check submitter before attempting the update.
      if (role === "board") {
        const check = await client.query(
          `SELECT submitted_by FROM public.transactions
            WHERE owner_id = $1 AND id = $2
            LIMIT 1`,
          [ownerId, txId]
        );
        const row = check?.rows?.[0];
        if (row && String(row.submitted_by || "") === String(ownerId)) {
          const err = new Error("Board members cannot review the owner's submissions.");
          err.code = "PERMISSION_DENIED";
          throw err;
        }
      }

      const r = await client.query(
        `
        UPDATE public.transactions
        SET
          submission_status = $1,
          reviewed_at = now(),
          reviewer_note = $2
        WHERE owner_id = $3
          AND id = $4
          AND submission_status = 'pending_review'
        RETURNING id, kind, amount_cents, description, submission_status, reviewed_at
        `,
        [newStatus, reviewerNote, ownerId, txId]
      );

      if (!r.rowCount) {
        const err = new Error("Transaction not found or already reviewed.");
        err.code = "NOT_FOUND";
        throw err;
      }

      return r.rows[0];
    });

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "EXPENSE_REVIEW_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "NOT_FOUND" ? 404 :
      500;
    console.error("[CREW_REVIEW_EXPENSES] action error", e?.message || e);
    return jsonErr(res, status, code, "Unable to review submission.");
  }
});

module.exports = router;