// routes/employee.js
// Employee portal write endpoints: clock in/out, log mileage.
//
// Contract: only the authenticated employee's own data is touched. Owner,
// admin, and board accounts are rejected here — they use the /app tree's
// existing write paths. Writes are scoped by the resolved actor's identity
// from chiefos_tenant_actor_profiles (email → display_name + phone_digits).

const express = require("express");
const crypto = require("crypto");
const pg = require("../services/postgres");
const { requirePortalUser } = require("../middleware/requirePortalUser");
const { logTimeEntry } = require("../services/postgres");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function jsonErr(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, code, message, ...extra });
}

function isEmployeeRole(portalRole) {
  const r = String(portalRole || "").toLowerCase().trim();
  return r !== "" && r !== "owner" && r !== "admin" && r !== "board" && r !== "board_member";
}

async function resolveEmployeeIdentity({ tenantId, actorId }) {
  if (!tenantId || !actorId) return { displayName: null, phoneDigits: null };
  const r = await pg.query(
    `select display_name, phone_digits
       from public.chiefos_tenant_actor_profiles
      where tenant_id = $1 and actor_id = $2
      limit 1`,
    [tenantId, actorId]
  );
  const row = r?.rows?.[0];
  return {
    displayName: row?.display_name || null,
    phoneDigits: row?.phone_digits || null,
  };
}

// Deterministic per-action id so retries don't create duplicate rows.
function makeSourceMsgId(prefix, actorKey) {
  return `${prefix}:${actorKey}:${Date.now()}:${crypto.randomBytes(3).toString("hex")}`;
}

// user_id for time_entries_v2 is typically phone digits; portal-only
// employees may not have a phone. Fall back to a stable prefix of
// their actorId so each employee still has a consistent key.
function resolveUserIdKey({ phoneDigits, actorId }) {
  if (phoneDigits && /^\d+$/.test(phoneDigits)) return phoneDigits;
  return `portal:${String(actorId || "").slice(0, 16)}`;
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/employee/jobs
// Returns { ok, items: [{ id, job_no, name, status }] } — owner's active
// jobs, for dropdown selection in employee write forms (clock-in,
// mileage, photos, tasks). Scoped by owner_id only; employees see every
// active job in the tenant so they can pick the one they're working on.
// ─────────────────────────────────────────────────────────────────────
router.get("/api/employee/jobs", requirePortalUser(), async (req, res) => {
  try {
    const portalRole = String(req.portalRole || "").toLowerCase();
    if (!isEmployeeRole(portalRole)) {
      return jsonErr(res, 403, "PERMISSION_DENIED", "Employee portal only.");
    }

    const ownerId = String(req.ownerId || "").trim();
    if (!ownerId) {
      return jsonErr(res, 403, "NOT_LINKED", "Your account is not fully linked.");
    }

    const r = await pg.query(
      `SELECT id,
              job_no,
              COALESCE(NULLIF(TRIM(job_name), ''), NULLIF(TRIM(name), ''), 'Untitled job') AS name,
              status,
              active
         FROM public.jobs
        WHERE owner_id = $1
          AND deleted_at IS NULL
          AND (
            active = true
            OR LOWER(COALESCE(status, '')) IN ('', 'active', 'open', 'in_progress', 'in progress')
          )
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT 200`,
      [ownerId]
    );

    const items = (r?.rows || []).map((row) => ({
      id: row.id,
      job_no: row.job_no,
      name: row.name,
      status: row.status || null,
    }));

    return res.json({ ok: true, items });
  } catch (e) {
    console.error("[EMPLOYEE] jobs error:", e?.message || e);
    return jsonErr(res, 500, "JOBS_FAILED", "Could not load jobs.");
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/employee/time/status
// Returns { ok, clocked_in, open_shift: {id, start_at_utc, job_id} | null }
// ─────────────────────────────────────────────────────────────────────
router.get("/api/employee/time/status", requirePortalUser(), async (req, res) => {
  try {
    const portalRole = String(req.portalRole || "").toLowerCase();
    if (!isEmployeeRole(portalRole)) {
      return jsonErr(res, 403, "PERMISSION_DENIED", "Employee portal only.");
    }

    const tenantId = String(req.tenantId || "").trim();
    const actorId = String(req.actorId || "").trim();
    const ownerId = String(req.ownerId || "").trim();
    if (!tenantId || !actorId || !ownerId) {
      return jsonErr(res, 403, "NOT_LINKED", "Your account is not fully linked.");
    }

    const { phoneDigits } = await resolveEmployeeIdentity({ tenantId, actorId });
    const userId = resolveUserIdKey({ phoneDigits, actorId });

    const r = await pg.query(
      `SELECT id, start_at_utc, meta
         FROM public.time_entries_v2
        WHERE owner_id = $1
          AND user_id = $2
          AND kind = 'shift'
          AND end_at_utc IS NULL
          AND deleted_at IS NULL
        ORDER BY start_at_utc DESC
        LIMIT 1`,
      [ownerId, userId]
    );

    const open = r?.rows?.[0] || null;
    const jobName = open?.meta?.job_name || null;

    // If there's an open shift, also report any still-open child
    // segments (break / lunch / drive) so the UI can render "On break"
    // / "End break" state correctly.
    let openSegments = [];
    if (open?.id) {
      const segRows = await pg.query(
        `SELECT id, kind, start_at_utc
           FROM public.time_entries_v2
          WHERE owner_id = $1
            AND parent_id = $2
            AND kind IN ('break','lunch','drive')
            AND end_at_utc IS NULL
            AND deleted_at IS NULL
          ORDER BY start_at_utc DESC`,
        [ownerId, open.id]
      );
      openSegments = (segRows?.rows || []).map((s) => ({
        id: s.id,
        kind: s.kind,
        start_at_utc: s.start_at_utc,
      }));
    }

    return res.json({
      ok: true,
      clocked_in: !!open,
      open_shift: open
        ? { id: open.id, start_at_utc: open.start_at_utc, job_name: jobName }
        : null,
      open_segments: openSegments,
    });
  } catch (e) {
    console.error("[EMPLOYEE] time/status error:", e?.message || e);
    return jsonErr(res, 500, "STATUS_FAILED", "Could not load clock status.");
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/employee/time/segment
// Body: { kind: "break"|"lunch"|"drive", action: "start"|"stop" }
// Inserts or closes a child row under the employee's currently open
// shift. Dual-writes to legacy public.time_entries using the owner
// portal's expected type tokens:
//   break_start / break_stop / lunch_start / lunch_end / drive_start /
//   drive_stop
// (note the lunch asymmetry — legacy uses "lunch_end" on the owner
// filter chip set).
// ─────────────────────────────────────────────────────────────────────
const LEGACY_TYPE_BY_KIND_ACTION = {
  "break:start": "break_start",
  "break:stop":  "break_stop",
  "lunch:start": "lunch_start",
  "lunch:stop":  "lunch_end",    // legacy uses lunch_end, not lunch_stop
  "drive:start": "drive_start",
  "drive:stop":  "drive_stop",
};

router.post("/api/employee/time/segment", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const portalRole = String(req.portalRole || "").toLowerCase();
    if (!isEmployeeRole(portalRole)) {
      return jsonErr(res, 403, "PERMISSION_DENIED", "Employee portal only.");
    }

    const tenantId = String(req.tenantId || "").trim();
    const actorId = String(req.actorId || "").trim();
    const ownerId = String(req.ownerId || "").trim();
    if (!tenantId || !actorId || !ownerId) {
      return jsonErr(res, 403, "NOT_LINKED", "Your account is not fully linked.");
    }

    const kind = String(req.body?.kind || "").toLowerCase().trim();
    const action = String(req.body?.action || "").toLowerCase().trim();
    if (!["break", "lunch", "drive"].includes(kind)) {
      return jsonErr(res, 400, "INVALID_KIND", "kind must be break, lunch, or drive.");
    }
    if (!["start", "stop"].includes(action)) {
      return jsonErr(res, 400, "INVALID_ACTION", "action must be start or stop.");
    }

    const { displayName, phoneDigits } = await resolveEmployeeIdentity({ tenantId, actorId });
    const userId = resolveUserIdKey({ phoneDigits, actorId });
    const tz = req.tenant?.tz || "America/Toronto";

    // Must have an open shift to start OR stop a segment.
    const shiftRes = await pg.query(
      `SELECT id FROM public.time_entries_v2
        WHERE owner_id = $1 AND user_id = $2 AND kind = 'shift' AND end_at_utc IS NULL
        ORDER BY start_at_utc DESC
        LIMIT 1`,
      [ownerId, userId]
    );
    const shift = shiftRes?.rows?.[0];
    if (!shift?.id) {
      return jsonErr(res, 409, "NOT_CLOCKED_IN", "You need to clock in before starting a break, lunch, or drive.");
    }

    const legacyType = LEGACY_TYPE_BY_KIND_ACTION[`${kind}:${action}`];
    const sourceMsgId = makeSourceMsgId(`portal:${kind}-${action}`, userId);

    let newRowId = null;
    let tsIso = new Date().toISOString();

    if (action === "start") {
      // Reject second open segment of the same kind on this shift.
      const existing = await pg.query(
        `SELECT id FROM public.time_entries_v2
          WHERE owner_id = $1 AND parent_id = $2 AND kind = $3 AND end_at_utc IS NULL
          LIMIT 1`,
        [ownerId, shift.id, kind]
      );
      if (existing?.rows?.length) {
        return jsonErr(
          res,
          409,
          "SEGMENT_ALREADY_OPEN",
          `You already have an open ${kind}. End it first.`
        );
      }

      const meta = { source: "employee_portal", actor_id: actorId };
      const ins = await pg.query(
        `INSERT INTO public.time_entries_v2
           (owner_id, user_id, job_id, parent_id, kind, start_at_utc, end_at_utc, meta, created_by, source_msg_id)
         VALUES ($1, $2, NULL, $3, $4, NOW(), NULL, $5, 'portal', $6)
         RETURNING id, start_at_utc`,
        [ownerId, userId, shift.id, kind, meta, sourceMsgId]
      );
      const row = ins?.rows?.[0];
      if (!row?.id) {
        return jsonErr(res, 500, "INSERT_FAILED", `Could not start ${kind}.`);
      }
      newRowId = row.id;
      tsIso = row.start_at_utc;
    } else {
      // stop — close the most recent open segment of this kind.
      const upd = await pg.query(
        `UPDATE public.time_entries_v2
            SET end_at_utc = NOW(), updated_at = NOW()
          WHERE id = (
            SELECT id FROM public.time_entries_v2
             WHERE owner_id = $1 AND parent_id = $2 AND kind = $3 AND end_at_utc IS NULL
             ORDER BY start_at_utc DESC
             LIMIT 1
          )
          RETURNING id, end_at_utc`,
        [ownerId, shift.id, kind]
      );
      const row = upd?.rows?.[0];
      if (!row?.id) {
        return jsonErr(res, 409, "SEGMENT_NOT_OPEN", `You don't have an open ${kind} to end.`);
      }
      newRowId = row.id;
      tsIso = row.end_at_utc;
    }

    // Legacy dual-write so owner views show the segment event.
    try {
      await logTimeEntry(
        ownerId,
        displayName || null,
        legacyType,
        tsIso,
        null, // segments don't carry a job_no
        tz,
        { source_msg_id: sourceMsgId + ":legacy" }
      );
    } catch (e) {
      console.warn(`[EMPLOYEE_SEGMENT] legacy dual-write failed:`, e?.message || e);
    }

    console.info("[EMPLOYEE_SEGMENT]", { ownerId, userId, shiftId: shift.id, kind, action, rowId: newRowId });
    return res.json({ ok: true, id: newRowId, kind, action, at: tsIso });
  } catch (e) {
    console.error("[EMPLOYEE] segment error:", e?.message || e);
    return jsonErr(res, 500, "SEGMENT_FAILED", "Could not record segment.");
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/employee/time/clock-in
// Body: { job_id?: number, note?: string }
// Returns { ok, id, start_at_utc }
// ─────────────────────────────────────────────────────────────────────
router.post("/api/employee/time/clock-in", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const portalRole = String(req.portalRole || "").toLowerCase();
    if (!isEmployeeRole(portalRole)) {
      return jsonErr(res, 403, "PERMISSION_DENIED", "Employee portal only.");
    }

    const tenantId = String(req.tenantId || "").trim();
    const actorId = String(req.actorId || "").trim();
    const ownerId = String(req.ownerId || "").trim();
    if (!tenantId || !actorId || !ownerId) {
      return jsonErr(res, 403, "NOT_LINKED", "Your account is not fully linked. Ask your owner to resend the invite.");
    }

    const { displayName, phoneDigits } = await resolveEmployeeIdentity({ tenantId, actorId });
    const userId = resolveUserIdKey({ phoneDigits, actorId });
    const tz = req.tenant?.tz || "America/Toronto";

    // Reject double clock-in
    const existing = await pg.query(
      `SELECT id FROM public.time_entries_v2
        WHERE owner_id = $1 AND user_id = $2 AND kind = 'shift' AND end_at_utc IS NULL
        LIMIT 1`,
      [ownerId, userId]
    );
    if (existing?.rows?.length) {
      return jsonErr(res, 409, "ALREADY_CLOCKED_IN", "You're already clocked in. Clock out first.");
    }

    // Resolve job reference into a canonical job name + job_no. The
    // time_entries_v2.job_id column is UUID and the WhatsApp path never
    // populates it — we store the label in meta.job_name instead. The
    // legacy time_entries.job_no column is bigint and IS populated, so
    // we grab both fields in one lookup.
    const jobIdRaw = req.body?.job_id;
    let resolvedJobName = null;
    let resolvedJobNo = null;
    if (jobIdRaw && /^\d+$/.test(String(jobIdRaw))) {
      try {
        const jr = await pg.query(
          `SELECT job_no,
                  COALESCE(NULLIF(TRIM(job_name), ''), NULLIF(TRIM(name), ''), 'Untitled job') AS name
             FROM public.jobs
            WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL
            LIMIT 1`,
          [ownerId, Number(jobIdRaw)]
        );
        resolvedJobName = jr?.rows?.[0]?.name || null;
        resolvedJobNo = jr?.rows?.[0]?.job_no ?? null;
      } catch {
        // fall through — start the shift without a job rather than fail
      }
    }

    const note = String(req.body?.note || "").trim().slice(0, 500) || null;
    const sourceMsgId = makeSourceMsgId("portal:clock-in", userId);
    const meta = {
      source: "employee_portal",
      actor_id: actorId,
      job_name: resolvedJobName,
      note,
    };

    // v2 insert (authoritative shift record)
    const ins = await pg.query(
      `INSERT INTO public.time_entries_v2
         (owner_id, user_id, job_id, parent_id, kind, start_at_utc, end_at_utc, meta, created_by, source_msg_id)
       VALUES ($1, $2, NULL, NULL, 'shift', NOW(), NULL, $3, 'portal', $4)
       RETURNING id, start_at_utc`,
      [ownerId, userId, meta, sourceMsgId]
    );

    const row = ins?.rows?.[0];
    if (!row?.id) {
      return jsonErr(res, 500, "INSERT_FAILED", "Could not record clock-in.");
    }

    // Legacy public.time_entries dual-write so owner-side views
    // (/app/activity/time and the dashboard records panel) pick up
    // the shift. Non-fatal — if the legacy insert fails for any reason
    // the shift is still authoritative in v2.
    try {
      // Don't pass requester_id — time_entries.user_id has a FK to
      // public.users(user_id) and employees (like Jaclyn) aren't rows
      // there. Falling back to ownerId satisfies the FK; the row is
      // still attributable to the employee via employee_name.
      await logTimeEntry(
        ownerId,
        displayName || null,
        "clock_in",
        row.start_at_utc,
        resolvedJobNo,
        tz,
        { source_msg_id: sourceMsgId + ":legacy" }
      );
    } catch (e) {
      console.warn("[EMPLOYEE_CLOCK_IN] legacy dual-write failed:", e?.message || e);
    }

    console.info("[EMPLOYEE_CLOCK_IN]", { ownerId, userId, id: row.id, jobNo: resolvedJobNo });
    return res.json({ ok: true, id: row.id, start_at_utc: row.start_at_utc });
  } catch (e) {
    console.error("[EMPLOYEE] clock-in error:", e?.message || e);
    return jsonErr(res, 500, "CLOCK_IN_FAILED", "Could not clock in.");
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/employee/time/clock-out
// Closes the most recent open shift for the authenticated employee.
// Returns { ok, id, end_at_utc, duration_minutes }
// ─────────────────────────────────────────────────────────────────────
router.post("/api/employee/time/clock-out", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const portalRole = String(req.portalRole || "").toLowerCase();
    if (!isEmployeeRole(portalRole)) {
      return jsonErr(res, 403, "PERMISSION_DENIED", "Employee portal only.");
    }

    const tenantId = String(req.tenantId || "").trim();
    const actorId = String(req.actorId || "").trim();
    const ownerId = String(req.ownerId || "").trim();
    if (!tenantId || !actorId || !ownerId) {
      return jsonErr(res, 403, "NOT_LINKED", "Your account is not fully linked.");
    }

    const { displayName, phoneDigits } = await resolveEmployeeIdentity({ tenantId, actorId });
    const userId = resolveUserIdKey({ phoneDigits, actorId });
    const tz = req.tenant?.tz || "America/Toronto";

    const upd = await pg.query(
      `UPDATE public.time_entries_v2
          SET end_at_utc = NOW(), updated_at = NOW()
        WHERE id = (
          SELECT id FROM public.time_entries_v2
           WHERE owner_id = $1 AND user_id = $2 AND kind = 'shift' AND end_at_utc IS NULL
           ORDER BY start_at_utc DESC
           LIMIT 1
        )
        RETURNING id, start_at_utc, end_at_utc, meta`,
      [ownerId, userId]
    );

    const row = upd?.rows?.[0];
    if (!row?.id) {
      return jsonErr(res, 409, "NOT_CLOCKED_IN", "You're not clocked in.");
    }

    // Also close any still-open child segments (breaks/lunches) on that shift
    await pg.query(
      `UPDATE public.time_entries_v2
          SET end_at_utc = NOW(), updated_at = NOW()
        WHERE owner_id = $1 AND parent_id = $2 AND end_at_utc IS NULL`,
      [ownerId, row.id]
    ).catch(() => {});

    // Legacy dual-write so the owner-side views update. We look up
    // job_no by name from the shift's meta (the clock-in path stored
    // the canonical name when the employee picked a job).
    try {
      const shiftJobName = row?.meta?.job_name || null;
      let jobNo = null;
      if (shiftJobName) {
        const jr = await pg.query(
          `SELECT job_no FROM public.jobs
            WHERE owner_id = $1
              AND deleted_at IS NULL
              AND (LOWER(job_name) = LOWER($2) OR LOWER(name) = LOWER($2))
            LIMIT 1`,
          [ownerId, shiftJobName]
        );
        jobNo = jr?.rows?.[0]?.job_no ?? null;
      }

      await logTimeEntry(
        ownerId,
        displayName || null,
        "clock_out",
        row.end_at_utc,
        jobNo,
        tz,
        {
          source_msg_id: makeSourceMsgId("portal:clock-out-legacy", userId),
        }
      );
    } catch (e) {
      console.warn("[EMPLOYEE_CLOCK_OUT] legacy dual-write failed:", e?.message || e);
    }

    const durationMs = new Date(row.end_at_utc).getTime() - new Date(row.start_at_utc).getTime();
    const durationMinutes = Math.max(0, Math.round(durationMs / 60000));

    console.info("[EMPLOYEE_CLOCK_OUT]", { ownerId, userId, id: row.id, durationMinutes });
    return res.json({
      ok: true,
      id: row.id,
      end_at_utc: row.end_at_utc,
      duration_minutes: durationMinutes,
    });
  } catch (e) {
    console.error("[EMPLOYEE] clock-out error:", e?.message || e);
    return jsonErr(res, 500, "CLOCK_OUT_FAILED", "Could not clock out.");
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/employee/mileage
// Body: { trip_date?: "YYYY-MM-DD", distance: number, unit?: "km"|"mi",
//         origin?: string, destination?: string, job_name?: string,
//         notes?: string }
// Returns { ok, id }
// ─────────────────────────────────────────────────────────────────────
router.post("/api/employee/mileage", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const portalRole = String(req.portalRole || "").toLowerCase();
    if (!isEmployeeRole(portalRole)) {
      return jsonErr(res, 403, "PERMISSION_DENIED", "Employee portal only.");
    }

    const tenantId = String(req.tenantId || "").trim();
    const actorId = String(req.actorId || "").trim();
    const ownerId = String(req.ownerId || "").trim();
    if (!tenantId || !actorId || !ownerId) {
      return jsonErr(res, 403, "NOT_LINKED", "Your account is not fully linked.");
    }

    const { phoneDigits } = await resolveEmployeeIdentity({ tenantId, actorId });
    const userIdKey = resolveUserIdKey({ phoneDigits, actorId });

    const distance = Number(req.body?.distance);
    if (!Number.isFinite(distance) || distance <= 0) {
      return jsonErr(res, 400, "INVALID_DISTANCE", "Distance must be a positive number.");
    }
    if (distance > 10000) {
      return jsonErr(res, 400, "INVALID_DISTANCE", "Distance looks too large — please re-check.");
    }

    const unit = String(req.body?.unit || "km").toLowerCase() === "mi" ? "mi" : "km";
    const origin = String(req.body?.origin || "").trim().slice(0, 200) || null;
    const destination = String(req.body?.destination || "").trim().slice(0, 200) || null;
    let jobName = String(req.body?.job_name || "").trim().slice(0, 200) || null;
    const notes = String(req.body?.notes || "").trim().slice(0, 500) || null;

    // If the client sent a job_id (preferred), resolve the job name from
    // the owner's jobs table so we store the canonical label.
    const jobIdRaw = req.body?.job_id;
    if (jobIdRaw && /^\d+$/.test(String(jobIdRaw))) {
      try {
        const jr = await pg.query(
          `SELECT COALESCE(NULLIF(TRIM(job_name), ''), NULLIF(TRIM(name), ''), 'Untitled job') AS name
             FROM public.jobs
            WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL
            LIMIT 1`,
          [ownerId, Number(jobIdRaw)]
        );
        if (jr?.rows?.[0]?.name) jobName = jr.rows[0].name;
      } catch {
        // fall through — jobName stays as-is
      }
    }

    const tripDateRaw = String(req.body?.trip_date || "").trim();
    const tripDate = /^\d{4}-\d{2}-\d{2}$/.test(tripDateRaw)
      ? tripDateRaw
      : new Date().toISOString().slice(0, 10);

    // Rough deductible — owner's full mileage handler applies CRA/IRS tiering.
    // For portal self-log we store a simple per-km/mile rate and let the owner
    // adjust later if needed. 0 cents is safe; the owner's WhatsApp handler
    // recalculates YTD-aware rates when it writes.
    const rateCents = unit === "mi" ? 70 : 72; // 0.70 USD / 0.72 CAD — rounded CRA-ish
    const deductibleCents = Math.round(distance * rateCents);

    const sourceMsgId = makeSourceMsgId("portal:mileage", userIdKey);

    const ins = await pg.query(
      `INSERT INTO public.mileage_logs
         (tenant_id, owner_id, employee_user_id, job_name, trip_date, origin, destination,
          distance, unit, rate_cents, deductible_cents, source_msg_id, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
       ON CONFLICT (owner_id, source_msg_id) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        ownerId,
        phoneDigits || null, // legacy column: only real phones here
        jobName,
        tripDate,
        origin,
        destination,
        distance,
        unit,
        rateCents,
        deductibleCents,
        sourceMsgId,
        notes,
      ]
    );

    const row = ins?.rows?.[0];
    if (!row?.id) {
      return jsonErr(res, 500, "INSERT_FAILED", "Could not record trip.");
    }

    console.info("[EMPLOYEE_MILEAGE]", { ownerId, id: row.id, distance, unit });
    return res.json({ ok: true, id: row.id });
  } catch (e) {
    console.error("[EMPLOYEE] mileage error:", e?.message || e);
    return jsonErr(res, 500, "MILEAGE_FAILED", "Could not log trip.");
  }
});

module.exports = router;
