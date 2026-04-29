// routes/crewReview.js
// ============================================================================
// Owner crew-review API (R3b rewrite, 2026-04-24).
//
// Replaces the pre-rebuild stateful-row design (chiefos_activity_logs rows
// mutated through review states + chiefos_activity_log_events child table)
// with the rebuild model: crew submissions are canonical rows on
// time_entries_v2 / tasks with submission_status; owner transitions
// submission_status; every transition emits one chiefos_activity_logs row
// via emitActivityLog (canonical helper, FOUNDATION §3.11).
//
// Routes (all under /api/crew, mounted with requirePortalUser at index.js):
//   GET   /review/inbox                — list pending crew submissions
//                                        (time_entries_v2 + tasks union)
//   PATCH /review/:id                  — owner action on crew submission
//                                        body: { target_table, action, note?, reason? }
//                                        action: 'approve' | 'reject' | 'needs_clarification'
//   GET   /review/expenses/pending     — pending transactions (separate enum)
//   PATCH /review/expenses/:id         — owner action on transaction
//                                        body: { action, reviewer_note? }
//                                        action: 'approve' | 'decline'
//
// Permission: owner | admin | board (board cannot act on owner's submissions).
// Role source: req.portalRole populated by requirePortalUser middleware.
// ============================================================================

const express = require("express");
const pg = require("../services/postgres");
const {
  listPendingForReview,
  transitionSubmissionStatus,
  VALID_TARGET_TABLES,
} = require("../services/crewControl");
const { requireCrewControlPro } = require("../middleware/requireCrewControlPro");
const { requirePortalUser } = require("../middleware/requirePortalUser");

const router = express.Router();

const REVIEW_ROLES = new Set(["owner", "admin", "board"]);

function jsonErr(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, code, message, ...extra });
}

function requireReviewerRole(req, res) {
  const role = String(req.portalRole || req.actorRole || "").toLowerCase();
  if (!REVIEW_ROLES.has(role)) {
    jsonErr(res, 403, "PERMISSION_DENIED", "Reviewer role required (owner|admin|board).");
    return null;
  }
  return role;
}

// ── GET /review/inbox ───────────────────────────────────────────────────────
// Returns canonical rows (time_entries_v2 + tasks) with submission_status in
// ('pending_review','needs_clarification'). Board members see all (including
// rows submitted by owner; owner-vs-actor exclusion is a future refinement,
// matches pre-rebuild behavior for the canonical-table pivot).
router.get("/review/inbox", requirePortalUser(), requireCrewControlPro(), async (req, res) => {
  try {
    const role = requireReviewerRole(req, res);
    if (!role) return;

    const items = await listPendingForReview(req, { limit: 200 });
    return res.json({ ok: true, role, items });
  } catch (e) {
    const code = e?.code || "INBOX_FAILED";
    const status = code === "TENANT_BOUNDARY_MISSING" ? 403 : 500;
    console.error("[CREW_REVIEW] inbox error", e?.message || e);
    return jsonErr(res, status, code, "Unable to load review inbox.");
  }
});

// ── PATCH /review/:id ───────────────────────────────────────────────────────
// Body: { target_table: 'time_entries_v2'|'tasks', action: 'approve'|'reject'|'needs_clarification', note?, reason? }
// Approve   → submission_status='approved',            action_kind='confirm'
// Reject    → submission_status='rejected',            action_kind='reject',  payload.note=reason
// Clarify   → submission_status='needs_clarification', action_kind='update',  payload.note=note
router.patch("/review/:id", requirePortalUser(), requireCrewControlPro(), express.json(), async (req, res) => {
  try {
    const role = requireReviewerRole(req, res);
    if (!role) return;

    const targetId = String(req.params.id || "").trim();
    if (!targetId) return jsonErr(res, 400, "MISSING_ID", "Submission id required.");

    const target_table = String(req.body?.target_table || "").trim();
    if (!VALID_TARGET_TABLES.has(target_table)) {
      return jsonErr(res, 400, "INVALID_TARGET_TABLE", "target_table must be time_entries_v2 or tasks.");
    }

    const action = String(req.body?.action || "").trim();
    let new_status;
    let note;
    if (action === "approve") {
      new_status = "approved";
      note = null;
    } else if (action === "reject") {
      new_status = "rejected";
      note = String(req.body?.reason || req.body?.note || "").trim();
      if (!note) return jsonErr(res, 400, "REASON_REQUIRED", "Reject requires a reason.");
    } else if (action === "needs_clarification" || action === "needs-clarification") {
      new_status = "needs_clarification";
      note = String(req.body?.note || "").trim();
      if (!note) return jsonErr(res, 400, "NOTE_REQUIRED", "Clarification requires a note.");
    } else {
      return jsonErr(res, 400, "INVALID_ACTION", "Action must be approve|reject|needs_clarification.");
    }

    const out = await transitionSubmissionStatus(req, { target_table, target_id: targetId, new_status, note });
    if (!out?.ok) {
      const code = out?.error?.code || "REVIEW_FAILED";
      const status = code === "NOT_FOUND_OR_OUT_OF_TENANT" ? 404 : 500;
      return jsonErr(res, status, code, out?.error?.message || "Unable to transition submission state.");
    }

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "REVIEW_FAILED";
    const status = code === "TENANT_BOUNDARY_MISSING" ? 403 : 500;
    console.error("[CREW_REVIEW] action error", e?.message || e);
    return jsonErr(res, status, code, "Unable to review submission.");
  }
});

// ── GET /review/expenses/pending ───────────────────────────────────────────
// Pending transactions (separate from time_entries_v2/tasks because
// transactions has its own 3-value submission_status enum: confirmed |
// pending_review | voided — financial-row lifecycle, predates P1A-5).
router.get("/review/expenses/pending", requirePortalUser(), requireCrewControlPro(), async (req, res) => {
  try {
    const role = requireReviewerRole(req, res);
    if (!role) return;
    const tenantId = String(req.tenantId || "").trim();
    const ownerId = String(req.ownerId || "").trim();
    if (!tenantId || !ownerId) return jsonErr(res, 403, "TENANT_BOUNDARY_MISSING", "Access not resolved.");

    // Board members exclude rows submitted by the owner.
    const excludeOwnerSubmissions = role === "board";
    const sql = `
      SELECT
        t.id, t.kind, t.amount_cents, t.description, t.vendor, t.category,
        t.job_no, t.occurred_at, t.submitted_by, t.submission_status,
        t.reviewer_note, t.created_at
      FROM public.transactions t
      WHERE t.tenant_id = $1::uuid
        AND t.owner_id = $2
        AND t.submission_status = 'pending_review'
        AND t.kind IN ('expense', 'revenue')
        ${excludeOwnerSubmissions ? "AND (t.submitted_by IS NULL OR t.submitted_by <> $2)" : ""}
      ORDER BY t.created_at DESC
      LIMIT 100
    `;
    const r = await pg.query(sql, [tenantId, ownerId]);
    return res.json({ ok: true, items: r?.rows || [] });
  } catch (e) {
    console.error("[CREW_REVIEW_EXPENSES] list error", e?.message || e);
    return jsonErr(res, 500, "PENDING_EXPENSES_FAILED", "Unable to load pending submissions.");
  }
});

// ── PATCH /review/expenses/:id ─────────────────────────────────────────────
// Body: { action: 'approve'|'decline', reviewer_note? }
// Updates transactions.submission_status (3-value enum).
//   approve → 'confirmed' + emit action_kind='confirm'
//   decline → 'voided'    + emit action_kind='void'
// (Pre-rebuild used 'declined' which is not in the rebuild CHECK enum;
// corrected to 'voided' here per migration 2026_04_21_rebuild_financial_spine.sql:113.)
router.patch("/review/expenses/:id", requirePortalUser(), requireCrewControlPro(), express.json(), async (req, res) => {
  try {
    const role = requireReviewerRole(req, res);
    if (!role) return;
    const tenantId = String(req.tenantId || "").trim();
    const ownerId = String(req.ownerId || "").trim();
    if (!tenantId || !ownerId) return jsonErr(res, 403, "TENANT_BOUNDARY_MISSING", "Access not resolved.");

    const txId = String(req.params.id || "").trim();
    const action = String(req.body?.action || "").trim();
    const reviewerNote = String(req.body?.reviewer_note || "").trim() || null;

    if (!txId) return jsonErr(res, 400, "MISSING_ID", "Transaction id required.");
    if (!["approve", "decline"].includes(action)) {
      return jsonErr(res, 400, "INVALID_ACTION", "Action must be approve|decline.");
    }
    const newStatus = action === "approve" ? "confirmed" : "voided";
    const actionKind = action === "approve" ? "confirm" : "void";

    if (role === "board") {
      const check = await pg.query(
        `SELECT submitted_by FROM public.transactions
          WHERE tenant_id = $1::uuid AND owner_id = $2 AND id::text = $3
          LIMIT 1`,
        [tenantId, ownerId, txId]
      );
      const row = check?.rows?.[0];
      if (row && String(row.submitted_by || "") === String(ownerId)) {
        return jsonErr(res, 403, "PERMISSION_DENIED", "Board members cannot review the owner's submissions.");
      }
    }

    const r = await pg.query(
      `UPDATE public.transactions
          SET submission_status = $1, reviewed_at = now(), reviewer_note = $2
        WHERE tenant_id = $3::uuid
          AND owner_id = $4
          AND id::text = $5
          AND submission_status = 'pending_review'
        RETURNING id, kind, amount_cents, description, submission_status, reviewed_at`,
      [newStatus, reviewerNote, tenantId, ownerId, txId]
    );
    if (!r?.rowCount) {
      return jsonErr(res, 404, "NOT_FOUND", "Transaction not found or already reviewed.");
    }

    // Emit canonical activity log row for the transition.
    const { emitActivityLog } = require("../services/activityLog");
    const { buildActorContext } = require("../services/actorContext");
    const ctx = buildActorContext(req);
    await emitActivityLog(ctx, {
      action_kind: actionKind,
      target_table: "transactions",
      target_id: String(txId),
      payload: {
        from: "pending_review",
        to: newStatus,
        ...(reviewerNote ? { reviewer_note: reviewerNote } : {}),
      },
    });

    return res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    console.error("[CREW_REVIEW_EXPENSES] action error", e?.message || e);
    return jsonErr(res, 500, "EXPENSE_REVIEW_FAILED", "Unable to review submission.");
  }
});

module.exports = router;
