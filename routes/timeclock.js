// routes/timeclock.js
//
// Unified timeclock write API for owner + admin + board + employee.
//
// Every endpoint supports an optional target_actor_id query param (or
// body field) that lets owner/admin/board operate on behalf of another
// actor in the same tenant. Employees can only target themselves.
//
// Permission matrix
//   owner    → self OR any other actor in the tenant
//   admin    → self OR any other actor in the tenant
//   board    → self OR any non-owner actor in the tenant
//   employee → self only
//
// Writes mirror the WhatsApp timeclock path exactly: authoritative
// shift / segment rows in public.time_entries_v2 (shape: kind, meta,
// parent_id, start_at_utc/end_at_utc) AND a dual-write to the legacy
// public.time_entries via services/postgres.js::logTimeEntry so the
// owner-side read views (/app/activity/time + dashboard records panel)
// stay in sync. The legacy dual-write does NOT pass requester_id to
// avoid tripping the time_entries.user_id → users.user_id FK when the
// target is an employee without a users row.

const express = require("express");
const crypto = require("crypto");
const pg = require("../services/postgres");
const { requirePortalUser } = require("../middleware/requirePortalUser");
const { logTimeEntry } = require("../services/postgres");
const { emitActivityLog } = require("../services/activityLog");
const { buildActorContext } = require("../services/actorContext");

const router = express.Router();

// ── helpers ───────────────────────────────────────────────────────────

function jsonErr(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, code, message, ...extra });
}

function makeSourceMsgId(prefix, actorKey) {
  return `${prefix}:${actorKey}:${Date.now()}:${crypto.randomBytes(3).toString("hex")}`;
}

// Map the role of the caller + target into an allow/deny decision. The
// target's role drives the rules; the caller's role drives the check.
// Post-rebuild role enum: chiefos_portal_users.role IN (owner, board_member,
// employee); public.users.role IN (owner, employee, contractor). 'admin'
// from pre-rebuild is no longer a valid role.
function assertCanActFor(callerRole, targetRole) {
  const cr = String(callerRole || "").toLowerCase();
  const tr = String(targetRole || "").toLowerCase();
  if (cr === "owner") return null;
  if (cr === "board_member") {
    if (tr === "owner") {
      return { code: "PERMISSION_DENIED", message: "Board members cannot act for the owner." };
    }
    return null;
  }
  // employee / contractor (or any other role) can only target themselves —
  // the self-target short-circuit handles that above this call.
  return { code: "PERMISSION_DENIED", message: "You can only clock yourself in/out." };
}

// Load the target actor's identity fields for writes. Returns null if
// the actor doesn't belong to the caller's tenant.
//
// Post-rebuild, "actor" splits into two surfaces (Decision 12):
//   - portal members:    chiefos_portal_users.user_id is auth.users.id (uuid)
//   - WhatsApp-only emp: public.users.user_id is digit string (phone)
// Both surfaces live in the same tenant. The actorId argument is opaque text
// — could be a uuid (portal) or digits (whatsapp). The UNION below tries
// both, returns the first match, and tags the row with `source` so the
// caller can disambiguate. WhatsApp-paired employees only appear via the
// portal branch (auth_user_id IS NULL filter on the WA branch prevents dupes).
async function loadTenantActor({ tenantId, actorId }) {
  if (!tenantId || !actorId) return null;
  const r = await pg.query(
    `SELECT pu.user_id::text AS actor_id,
            pu.role,
            COALESCE(u.name, '')        AS display_name,
            u.user_id                   AS phone_digits,
            u.email                     AS email,
            'portal'::text              AS source
       FROM public.chiefos_portal_users pu
       LEFT JOIN public.users u
         ON u.auth_user_id = pu.user_id AND u.tenant_id = pu.tenant_id
      WHERE pu.tenant_id = $1
        AND pu.user_id::text = $2
        AND pu.status = 'active'
     UNION ALL
     SELECT u.user_id                   AS actor_id,
            u.role,
            COALESCE(u.name, '')        AS display_name,
            u.user_id                   AS phone_digits,
            u.email                     AS email,
            'whatsapp'::text            AS source
       FROM public.users u
      WHERE u.tenant_id = $1
        AND u.user_id = $2
        AND u.auth_user_id IS NULL
      LIMIT 1`,
    [tenantId, actorId]
  );
  return r?.rows?.[0] || null;
}

// user_id stored on time_entries_v2 is usually phone digits; for
// portal-only users we fall back to a stable prefix of their actor id.
function userIdKey({ phoneDigits, actorId }) {
  if (phoneDigits && /^\d+$/.test(phoneDigits)) return phoneDigits;
  return `portal:${String(actorId || "").slice(0, 16)}`;
}

// Resolve the target_actor_id from request (query or body), falling
// back to the caller's own actor id when absent. Validates permission
// against the target's role and returns either { target: {...} } on
// success or { error: {status, code, message} } on failure.
async function resolveTarget(req) {
  const tenantId = String(req.tenantId || "").trim();
  const callerActorId = String(req.actorId || "").trim();
  const callerRole = String(req.portalRole || "").toLowerCase();

  if (!tenantId || !callerActorId) {
    return { error: { status: 403, code: "NOT_LINKED", message: "Your account is not fully linked." } };
  }

  const rawTarget = String(
    req.body?.target_actor_id ||
    req.query?.target_actor_id ||
    ""
  ).trim();

  // Self path — always allowed regardless of role.
  if (!rawTarget || rawTarget === callerActorId) {
    const self = await loadTenantActor({ tenantId, actorId: callerActorId });
    if (!self) {
      return { error: { status: 403, code: "NOT_LINKED", message: "Your account is not fully linked." } };
    }
    return {
      target: {
        actor_id: self.actor_id,
        role: self.role,
        display_name: self.display_name || null,
        phone_digits: self.phone_digits || null,
        is_self: true,
      },
    };
  }

  // Cross-actor path — load the target and check permission.
  const target = await loadTenantActor({ tenantId, actorId: rawTarget });
  if (!target) {
    return { error: { status: 404, code: "TARGET_NOT_FOUND", message: "That person isn't on your team." } };
  }
  const denial = assertCanActFor(callerRole, target.role);
  if (denial) {
    return { error: { status: 403, ...denial } };
  }
  return {
    target: {
      actor_id: target.actor_id,
      role: target.role,
      display_name: target.display_name || null,
      phone_digits: target.phone_digits || null,
      is_self: false,
    },
  };
}

// ── GET /api/timeclock/actors ────────────────────────────────────────
// Returns the list of tenant actors the caller may act on, each with
// is_self + is_allowed flags. Always includes the caller so the UI can
// render a "Me" option without a second query.
router.get("/api/timeclock/actors", requirePortalUser(), async (req, res) => {
  try {
    const tenantId = String(req.tenantId || "").trim();
    const callerActorId = String(req.actorId || "").trim();
    const callerRole = String(req.portalRole || "").toLowerCase();
    if (!tenantId) {
      return jsonErr(res, 403, "NOT_LINKED", "Your account is not fully linked.");
    }

    // Post-rebuild union: portal members (auth uuid) + WhatsApp-only
    // employees (digits user_id). The `source` field on each row lets the
    // frontend disambiguate without inspecting actor_id shape.
    const r = await pg.query(
      `SELECT pu.user_id::text                       AS actor_id,
              pu.role                                AS role,
              COALESCE(NULLIF(TRIM(u.name), ''),
                       NULLIF(TRIM(u.email), ''),
                       'Unnamed')                    AS display_name,
              'portal'::text                         AS source
         FROM public.chiefos_portal_users pu
         LEFT JOIN public.users u
           ON u.auth_user_id = pu.user_id AND u.tenant_id = pu.tenant_id
        WHERE pu.tenant_id = $1
          AND pu.status = 'active'
       UNION ALL
       SELECT u.user_id                              AS actor_id,
              u.role                                 AS role,
              COALESCE(NULLIF(TRIM(u.name), ''),
                       NULLIF(TRIM(u.email), ''),
                       'Unnamed')                    AS display_name,
              'whatsapp'::text                       AS source
         FROM public.users u
        WHERE u.tenant_id = $1
          AND u.auth_user_id IS NULL
        ORDER BY
          CASE role
            WHEN 'owner' THEN 0
            WHEN 'board_member' THEN 1
            WHEN 'employee' THEN 2
            WHEN 'contractor' THEN 3
            ELSE 4
          END,
          display_name ASC`,
      [tenantId]
    );

    const items = (r?.rows || []).map((row) => {
      const isSelf = row.actor_id === callerActorId;
      const denial = isSelf ? null : assertCanActFor(callerRole, row.role);
      return {
        actor_id: row.actor_id,
        role: row.role,
        display_name: row.display_name,
        source: row.source,
        is_self: isSelf,
        is_allowed: isSelf || !denial,
      };
    });

    return res.json({ ok: true, items });
  } catch (e) {
    console.error("[TIMECLOCK] actors error:", e?.message || e);
    return jsonErr(res, 500, "ACTORS_FAILED", "Could not load team list.");
  }
});

// ── GET /api/timeclock/jobs ──────────────────────────────────────────
// Mirrors /api/employee/jobs so both the employee and crew timeclock
// cards can use the same dropdown source. Owner-scoped, active only.
router.get("/api/timeclock/jobs", requirePortalUser(), async (req, res) => {
  try {
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
    console.error("[TIMECLOCK] jobs error:", e?.message || e);
    return jsonErr(res, 500, "JOBS_FAILED", "Could not load jobs.");
  }
});

// ── GET /api/timeclock/active-shifts ─────────────────────────────────
// Returns all currently open shifts across the tenant for the "Live
// Activity" widget on the owner dashboard and job detail pages.
router.get("/api/timeclock/active-shifts", requirePortalUser(), async (req, res) => {
  try {
    const tenantId = String(req.tenantId || "").trim();
    if (!tenantId) return res.json({ ok: true, shifts: [] });

    const jobId = req.query.job_id ? Number(req.query.job_id) : null;

    // Post-rebuild: resolve employee display_name via public.users
    // (user_id is the digits PK = phone_digits in te.user_id).
    let sql = `
      SELECT te.id, te.user_id, te.start_at_utc, te.meta,
             COALESCE(u.name, te.user_id) AS employee_name
        FROM public.time_entries_v2 te
        LEFT JOIN public.users u
          ON u.tenant_id = te.tenant_id AND u.user_id = te.user_id
       WHERE te.tenant_id = $1
         AND te.kind = 'shift'
         AND te.end_at_utc IS NULL`;
    const params = [tenantId];

    if (jobId) {
      sql += ` AND te.meta->>'job_name' = (
        SELECT COALESCE(NULLIF(TRIM(job_name), ''), NULLIF(TRIM(name), ''))
          FROM public.jobs WHERE id = $2 AND deleted_at IS NULL LIMIT 1)`;
      params.push(jobId);
    }

    sql += ` ORDER BY te.start_at_utc ASC`;

    const { rows } = await pg.query(sql, params);
    const shifts = rows.map((r) => ({
      id: r.id,
      employee_name: r.employee_name,
      start_at_utc: r.start_at_utc,
      job_name: r.meta?.job_name || null,
    }));

    return res.json({ ok: true, shifts });
  } catch (e) {
    console.error("[TIMECLOCK_ACTIVE_SHIFTS] error:", e?.message || e);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "Could not load active shifts." });
  }
});

// ── GET /api/timeclock/status ────────────────────────────────────────
// Returns { clocked_in, open_shift, open_segments, target } for the
// resolved target. Accepts target_actor_id via query param.
router.get("/api/timeclock/status", requirePortalUser(), async (req, res) => {
  try {
    const resolved = await resolveTarget(req);
    if (resolved.error) {
      return jsonErr(res, resolved.error.status, resolved.error.code, resolved.error.message);
    }
    const target = resolved.target;
    const ownerId = String(req.ownerId || "").trim();
    const userId = userIdKey({ phoneDigits: target.phone_digits, actorId: target.actor_id });

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
      target: {
        actor_id: target.actor_id,
        role: target.role,
        display_name: target.display_name,
        is_self: target.is_self,
      },
      clocked_in: !!open,
      open_shift: open
        ? { id: open.id, start_at_utc: open.start_at_utc, job_name: jobName }
        : null,
      open_segments: openSegments,
    });
  } catch (e) {
    console.error("[TIMECLOCK] status error:", e?.message || e);
    return jsonErr(res, 500, "STATUS_FAILED", "Could not load clock status.");
  }
});

// ── POST /api/timeclock/clock-in ─────────────────────────────────────
router.post("/api/timeclock/clock-in", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const resolved = await resolveTarget(req);
    if (resolved.error) {
      return jsonErr(res, resolved.error.status, resolved.error.code, resolved.error.message);
    }
    const target = resolved.target;
    const tenantId = String(req.tenantId || "").trim();
    const ownerId = String(req.ownerId || "").trim();
    const userId = userIdKey({ phoneDigits: target.phone_digits, actorId: target.actor_id });
    const tz = req.tenant?.tz || "America/Toronto";

    const existing = await pg.query(
      `SELECT id FROM public.time_entries_v2
        WHERE owner_id = $1 AND user_id = $2 AND kind = 'shift' AND end_at_utc IS NULL
        LIMIT 1`,
      [ownerId, userId]
    );
    if (existing?.rows?.length) {
      return jsonErr(res, 409, "ALREADY_CLOCKED_IN", `${target.is_self ? "You're" : (target.display_name || "They're")} already clocked in.`);
    }

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
        // non-fatal
      }
    }

    const note = String(req.body?.note || "").trim().slice(0, 500) || null;
    const sourceMsgId = makeSourceMsgId("tc:clock-in", userId);
    const meta = {
      source: target.is_self ? `${target.role}_portal` : "crew_portal",
      actor_id: target.actor_id,
      job_name: resolvedJobName,
      note,
      ...(target.is_self ? {} : { initiated_by_actor_id: req.actorId }),
    };

    // R3b: crew submissions land as pending_review for owner approval.
    // - Employee clocking themselves in → pending_review (crew submission).
    // - Owner/admin/board acting on self or behalf of another → approved
    //   (trusted role, no review needed).
    const submissionStatus =
      target.is_self && String(target.role || "").toLowerCase() === "employee"
        ? "pending_review"
        : "approved";

    const ins = await pg.query(
      `INSERT INTO public.time_entries_v2
         (tenant_id, owner_id, user_id, job_id, parent_id, kind, start_at_utc, end_at_utc, meta, created_by, source_msg_id, submission_status)
       VALUES ($1, $2, $3, NULL, NULL, 'shift', NOW(), NULL, $4, 'portal', $5, $6)
       RETURNING id, start_at_utc, submission_status`,
      [tenantId, ownerId, userId, meta, sourceMsgId, submissionStatus]
    );
    const row = ins?.rows?.[0];
    if (!row?.id) {
      return jsonErr(res, 500, "INSERT_FAILED", "Could not record clock-in.");
    }

    try {
      await logTimeEntry(
        ownerId,
        target.display_name || null,
        "clock_in",
        row.start_at_utc,
        resolvedJobNo,
        tz,
        { source_msg_id: sourceMsgId + ":legacy", tenant_id: tenantId, job_name: resolvedJobName }
      );
    } catch (e) {
      console.warn("[TIMECLOCK] legacy clock_in dual-write failed:", e?.message || e);
    }

    console.info("[TIMECLOCK_CLOCK_IN]", {
      callerRole: req.portalRole,
      target: target.actor_id,
      ownerId,
      userId,
      id: row.id,
      jobNo: resolvedJobNo,
    });
    return res.json({ ok: true, id: row.id, start_at_utc: row.start_at_utc });
  } catch (e) {
    console.error("[TIMECLOCK] clock-in error:", e?.message || e);
    return jsonErr(res, 500, "CLOCK_IN_FAILED", "Could not clock in.");
  }
});

// ── POST /api/timeclock/clock-out ────────────────────────────────────
router.post("/api/timeclock/clock-out", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const resolved = await resolveTarget(req);
    if (resolved.error) {
      return jsonErr(res, resolved.error.status, resolved.error.code, resolved.error.message);
    }
    const target = resolved.target;
    const ownerId = String(req.ownerId || "").trim();
    const userId = userIdKey({ phoneDigits: target.phone_digits, actorId: target.actor_id });
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
      return jsonErr(res, 409, "NOT_CLOCKED_IN", `${target.is_self ? "You're" : (target.display_name || "They're")} not clocked in.`);
    }

    await pg.query(
      `UPDATE public.time_entries_v2
          SET end_at_utc = NOW(), updated_at = NOW()
        WHERE owner_id = $1 AND parent_id = $2 AND end_at_utc IS NULL`,
      [ownerId, row.id]
    ).catch(() => {});

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
        target.display_name || null,
        "clock_out",
        row.end_at_utc,
        jobNo,
        tz,
        { source_msg_id: makeSourceMsgId("tc:clock-out-legacy", userId), tenant_id: tenantId, job_name: shiftJobName }
      );
    } catch (e) {
      console.warn("[TIMECLOCK] legacy clock_out dual-write failed:", e?.message || e);
    }

    const durationMs = new Date(row.end_at_utc).getTime() - new Date(row.start_at_utc).getTime();
    const durationMinutes = Math.max(0, Math.round(durationMs / 60000));

    // F3.3: emit canonical activity log row for the state change.
    try {
      await emitActivityLog(buildActorContext(req), {
        action_kind: "update",
        target_table: "time_entries_v2",
        target_id: String(row.id),
        payload: {
          event: "clock_out",
          target_user_id: userId,
          duration_minutes: durationMinutes,
          end_at_utc: row.end_at_utc,
        },
      });
    } catch (e) {
      console.warn("[TIMECLOCK] clock_out activity log emit failed (non-fatal):", e?.message || e);
    }

    console.info("[TIMECLOCK_CLOCK_OUT]", {
      callerRole: req.portalRole,
      target: target.actor_id,
      ownerId,
      userId,
      id: row.id,
      durationMinutes,
    });
    return res.json({
      ok: true,
      id: row.id,
      end_at_utc: row.end_at_utc,
      duration_minutes: durationMinutes,
    });
  } catch (e) {
    console.error("[TIMECLOCK] clock-out error:", e?.message || e);
    return jsonErr(res, 500, "CLOCK_OUT_FAILED", "Could not clock out.");
  }
});

// ── POST /api/timeclock/segment ──────────────────────────────────────
const LEGACY_TYPE_BY_KIND_ACTION = {
  "break:start": "break_start",
  "break:stop":  "break_stop",
  "lunch:start": "lunch_start",
  "lunch:stop":  "lunch_end",
  "drive:start": "drive_start",
  "drive:stop":  "drive_stop",
};

router.post("/api/timeclock/segment", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const resolved = await resolveTarget(req);
    if (resolved.error) {
      return jsonErr(res, resolved.error.status, resolved.error.code, resolved.error.message);
    }
    const target = resolved.target;

    const kind = String(req.body?.kind || "").toLowerCase().trim();
    const action = String(req.body?.action || "").toLowerCase().trim();
    if (!["break", "lunch", "drive"].includes(kind)) {
      return jsonErr(res, 400, "INVALID_KIND", "kind must be break, lunch, or drive.");
    }
    if (!["start", "stop"].includes(action)) {
      return jsonErr(res, 400, "INVALID_ACTION", "action must be start or stop.");
    }

    const tenantId = String(req.tenantId || "").trim();
    const ownerId = String(req.ownerId || "").trim();
    const userId = userIdKey({ phoneDigits: target.phone_digits, actorId: target.actor_id });
    const tz = req.tenant?.tz || "America/Toronto";

    const shiftRes = await pg.query(
      `SELECT id FROM public.time_entries_v2
        WHERE owner_id = $1 AND user_id = $2 AND kind = 'shift' AND end_at_utc IS NULL
        ORDER BY start_at_utc DESC
        LIMIT 1`,
      [ownerId, userId]
    );
    const shift = shiftRes?.rows?.[0];
    if (!shift?.id) {
      return jsonErr(res, 409, "NOT_CLOCKED_IN", `${target.is_self ? "You" : (target.display_name || "They")} need to be clocked in first.`);
    }

    const legacyType = LEGACY_TYPE_BY_KIND_ACTION[`${kind}:${action}`];
    const sourceMsgId = makeSourceMsgId(`tc:${kind}-${action}`, userId);

    let newRowId = null;
    let tsIso = new Date().toISOString();

    if (action === "start") {
      const existing = await pg.query(
        `SELECT id FROM public.time_entries_v2
          WHERE owner_id = $1 AND parent_id = $2 AND kind = $3 AND end_at_utc IS NULL
          LIMIT 1`,
        [ownerId, shift.id, kind]
      );
      if (existing?.rows?.length) {
        return jsonErr(res, 409, "SEGMENT_ALREADY_OPEN", `Open ${kind} already in progress. End it first.`);
      }
      const meta = {
        source: target.is_self ? `${target.role}_portal` : "crew_portal",
        actor_id: target.actor_id,
        ...(target.is_self ? {} : { initiated_by_actor_id: req.actorId }),
      };
      // R3b/F3: crew submissions land as pending_review (matches /clock-in).
      const submissionStatus =
        target.is_self && String(target.role || "").toLowerCase() === "employee"
          ? "pending_review"
          : "approved";
      const ins = await pg.query(
        `INSERT INTO public.time_entries_v2
           (tenant_id, owner_id, user_id, job_id, parent_id, kind, start_at_utc, end_at_utc, meta, created_by, source_msg_id, submission_status)
         VALUES ($1, $2, $3, NULL, $4, $5, NOW(), NULL, $6, 'portal', $7, $8)
         RETURNING id, start_at_utc, submission_status`,
        [tenantId, ownerId, userId, shift.id, kind, meta, sourceMsgId, submissionStatus]
      );
      const row = ins?.rows?.[0];
      if (!row?.id) {
        return jsonErr(res, 500, "INSERT_FAILED", `Could not start ${kind}.`);
      }
      newRowId = row.id;
      tsIso = row.start_at_utc;
    } else {
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
        return jsonErr(res, 409, "SEGMENT_NOT_OPEN", `No open ${kind} to end.`);
      }
      newRowId = row.id;
      tsIso = row.end_at_utc;
    }

    try {
      await logTimeEntry(
        ownerId,
        target.display_name || null,
        legacyType,
        tsIso,
        null,
        tz,
        { source_msg_id: sourceMsgId + ":legacy" }
      );
    } catch (e) {
      console.warn(`[TIMECLOCK] legacy ${legacyType} dual-write failed:`, e?.message || e);
    }

    // F3.3: emit canonical activity log. start branch is a row creation;
    // stop branch is an update on the existing row. Both target time_entries_v2.
    try {
      await emitActivityLog(buildActorContext(req), {
        action_kind: action === "start" ? "create" : "update",
        target_table: "time_entries_v2",
        target_id: String(newRowId),
        payload: {
          event: `${kind}_${action}`,
          target_user_id: userId,
          parent_shift_id: String(shift.id),
          at: tsIso,
        },
      });
    } catch (e) {
      console.warn("[TIMECLOCK] segment activity log emit failed (non-fatal):", e?.message || e);
    }

    console.info("[TIMECLOCK_SEGMENT]", {
      callerRole: req.portalRole,
      target: target.actor_id,
      kind,
      action,
      rowId: newRowId,
    });
    return res.json({ ok: true, id: newRowId, kind, action, at: tsIso });
  } catch (e) {
    console.error("[TIMECLOCK] segment error:", e?.message || e);
    return jsonErr(res, 500, "SEGMENT_FAILED", "Could not record segment.");
  }
});

// ─────────────────────────────────────────────────────────────────────
// Mileage — unified endpoint. Same permission matrix as the timeclock
// actions: owner/admin act on anyone, board act on anyone except the
// owner, employee acts on self only. Writes into public.mileage_logs
// with employee_user_id set to the target's phone digits (null when
// the target is portal-only without a phone).
// ─────────────────────────────────────────────────────────────────────

// POST /api/timeclock/mileage
// Body: { target_actor_id?, trip_date?, distance, unit?, origin?,
//         destination?, job_id?, job_name?, notes? }
router.post("/api/timeclock/mileage", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const resolved = await resolveTarget(req);
    if (resolved.error) {
      return jsonErr(res, resolved.error.status, resolved.error.code, resolved.error.message);
    }
    const target = resolved.target;
    const tenantId = String(req.tenantId || "").trim();
    const ownerId = String(req.ownerId || "").trim();

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
    const notes = String(req.body?.notes || "").trim().slice(0, 500) || null;

    // Job reference — prefer job_id lookup, fall back to literal job_name.
    let jobName = String(req.body?.job_name || "").trim().slice(0, 200) || null;
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
        // non-fatal
      }
    }

    const tripDateRaw = String(req.body?.trip_date || "").trim();
    const tripDate = /^\d{4}-\d{2}-\d{2}$/.test(tripDateRaw)
      ? tripDateRaw
      : new Date().toISOString().slice(0, 10);

    // Conservative per-unit rate — owner WhatsApp handler re-tiers
    // via CRA YTD rules, which is fine to let run on next WhatsApp
    // mileage entry. Portal entries get the flat rate.
    const rateCents = unit === "mi" ? 70 : 72;
    const deductibleCents = Math.round(distance * rateCents);

    // Always store a stable employee identifier so the read side can
    // resolve a name even when the employee hasn't linked a phone yet.
    // Mirrors the userIdKey pattern from the timeclock inserts.
    const employeeUserId = target.phone_digits || `portal:${target.actor_id.slice(0, 16)}`;
    const sourceMsgId = makeSourceMsgId(
      target.is_self ? `tc:mileage-self` : `tc:mileage-for:${target.actor_id.slice(0, 8)}`,
      employeeUserId || target.actor_id
    );

    // mileage_logs.owner_id is UUID (not phone digits). We store the
    // tenant UUID to satisfy the constraint. Skip ON CONFLICT — the
    // source_msg_id contains a timestamp + random hex so collisions
    // are effectively impossible and the unique constraint may not
    // exist in production if the migration was partial.
    const ins = await pg.query(
      `INSERT INTO public.mileage_logs
         (tenant_id, owner_id, employee_user_id, job_name, trip_date, origin, destination,
          distance, unit, rate_cents, deductible_cents, source_msg_id, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
       RETURNING id`,
      [
        tenantId,
        tenantId, // owner_id = tenant uuid (column is uuid, not phone digits)
        employeeUserId,
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

    // F3.3: emit canonical activity log row for the mileage entry creation.
    try {
      await emitActivityLog(buildActorContext(req), {
        action_kind: "create",
        target_table: "mileage_logs",
        target_id: String(row.id),
        payload: {
          event: "mileage_logged",
          target_actor_id: target.actor_id,
          employee_user_id: employeeUserId,
          distance,
          unit,
          deductible_cents: deductibleCents,
          job_name: jobName,
          trip_date: tripDate,
        },
      });
    } catch (e) {
      console.warn("[TIMECLOCK] mileage activity log emit failed (non-fatal):", e?.message || e);
    }

    console.info("[TIMECLOCK_MILEAGE]", {
      callerRole: req.portalRole,
      target: target.actor_id,
      ownerId,
      distance,
      unit,
      id: row.id,
    });
    return res.json({ ok: true, id: row.id, target: { actor_id: target.actor_id, display_name: target.display_name } });
  } catch (e) {
    console.error("[TIMECLOCK] mileage error:", e?.message || e);
    return jsonErr(res, 500, "MILEAGE_FAILED", "Could not log trip.");
  }
});

// ─────────────────────────────────────────────────────────────────────
// Tasks — create + complete. Same permission matrix as timeclock:
// owner/admin can assign to anyone, board can assign to anyone but
// the owner, employees can only create tasks assigned to themselves.
// ─────────────────────────────────────────────────────────────────────

// POST /api/timeclock/tasks
// Body: { target_actor_id?, title, body?, due_date?, job_id? }
router.post("/api/timeclock/tasks", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const resolved = await resolveTarget(req);
    if (resolved.error) {
      return jsonErr(res, resolved.error.status, resolved.error.code, resolved.error.message);
    }
    const target = resolved.target;
    const ownerId = String(req.ownerId || "").trim();

    const title = String(req.body?.title || "").trim().slice(0, 200);
    if (!title) {
      return jsonErr(res, 400, "MISSING_TITLE", "Task title is required.");
    }
    const body = String(req.body?.body || "").trim().slice(0, 2000) || null;

    const dueDateRaw = String(req.body?.due_date || "").trim();
    const dueAt = /^\d{4}-\d{2}-\d{2}$/.test(dueDateRaw)
      ? new Date(dueDateRaw + "T00:00:00")
      : null;

    // Resolve job_id → job_no + (optional) job name for display context.
    let jobNo = null;
    const jobIdRaw = req.body?.job_id;
    if (jobIdRaw && /^\d+$/.test(String(jobIdRaw))) {
      try {
        const jr = await pg.query(
          `SELECT job_no FROM public.jobs
            WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL
            LIMIT 1`,
          [ownerId, Number(jobIdRaw)]
        );
        jobNo = jr?.rows?.[0]?.job_no ?? null;
      } catch {
        // non-fatal
      }
    }

    // assigned_to = target's display_name to match the crewSelf read
    // path which queries LOWER(assigned_to) = LOWER(displayName).
    const assignedTo = target.display_name || null;
    const createdBy = String(req.actorId || "").trim() || null;
    const tenantId = String(req.tenantId || "").trim();
    const sourceMsgId = makeSourceMsgId(
      target.is_self ? "tc:task-self" : `tc:task-for:${target.actor_id.slice(0, 8)}`,
      createdBy || "portal"
    );

    // R3b/F3: crew submissions land as pending_review (matches /clock-in).
    // Owner/admin/board acting on self or behalf of another → approved.
    const submissionStatus =
      target.is_self && String(target.role || "").toLowerCase() === "employee"
        ? "pending_review"
        : "approved";

    const ins = await pg.query(
      `INSERT INTO public.tasks
         (tenant_id, owner_id, created_by, assigned_to, title, body, type, due_at, job_no, source_msg_id, status, submission_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'general', $7, $8, $9, 'open', $10, NOW(), NOW())
       ON CONFLICT DO NOTHING
       RETURNING id, task_no, title, assigned_to, due_at, status, submission_status`,
      [tenantId, ownerId, createdBy, assignedTo, title, body, dueAt, jobNo, sourceMsgId, submissionStatus]
    );

    const row = ins?.rows?.[0];
    if (!row?.id) {
      return jsonErr(res, 500, "INSERT_FAILED", "Could not create task.");
    }

    // F3.3: emit canonical activity log row for the task creation.
    try {
      await emitActivityLog(buildActorContext(req), {
        action_kind: "create",
        target_table: "tasks",
        target_id: String(row.id),
        payload: {
          event: "task_created",
          target_actor_id: target.actor_id,
          assigned_to: assignedTo,
          title,
          job_no: jobNo,
          submission_status: row.submission_status || null,
        },
      });
    } catch (e) {
      console.warn("[TIMECLOCK] task create activity log emit failed (non-fatal):", e?.message || e);
    }

    console.info("[TIMECLOCK_TASK_CREATE]", {
      callerRole: req.portalRole,
      target: target.actor_id,
      id: row.id,
      jobNo,
    });
    return res.json({ ok: true, task: row });
  } catch (e) {
    console.error("[TIMECLOCK] task create error:", e?.message || e);
    return jsonErr(res, 500, "TASK_CREATE_FAILED", "Could not create task.");
  }
});

// PATCH /api/timeclock/tasks/:id — mark done / reopen / delete
// Body: { action: "done"|"reopen"|"delete" }
router.patch("/api/timeclock/tasks/:id", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const ownerId = String(req.ownerId || "").trim();
    const tenantId = String(req.tenantId || "").trim();
    const callerActorId = String(req.actorId || "").trim();
    const callerRole = String(req.portalRole || "").toLowerCase();
    if (!ownerId || !tenantId || !callerActorId) {
      return jsonErr(res, 403, "NOT_LINKED", "Your account is not fully linked.");
    }

    const taskId = String(req.params.id || "").trim();
    if (!taskId) return jsonErr(res, 400, "MISSING_ID", "task id required.");

    const action = String(req.body?.action || "").toLowerCase().trim();
    if (!["done", "reopen", "delete"].includes(action)) {
      return jsonErr(res, 400, "INVALID_ACTION", "action must be done, reopen, or delete.");
    }
    const newStatus = action === "done" ? "done" : action === "reopen" ? "open" : "deleted";

    // Load the task and figure out whose it is.
    const t = await pg.query(
      `SELECT id, owner_id, assigned_to, status
         FROM public.tasks
        WHERE owner_id = $1 AND id = $2
        LIMIT 1`,
      [ownerId, taskId]
    );
    const task = t?.rows?.[0];
    if (!task) return jsonErr(res, 404, "NOT_FOUND", "Task not found.");

    // Permission: owner can touch anything; board_member can touch
    // anything except tasks assigned to the owner; employees can
    // only touch tasks assigned to themselves.
    // Post-rebuild role enum: {owner, board_member, employee} — 'admin' is
    // no longer a valid role.
    if (callerRole !== "owner") {
      // Need the caller's display name to compare against assigned_to.
      // Post-rebuild: name lives on public.users keyed by auth_user_id.
      const cr = await pg.query(
        `SELECT name FROM public.users
          WHERE tenant_id = $1 AND auth_user_id = $2 LIMIT 1`,
        [tenantId, callerActorId]
      );
      const callerName = String(cr?.rows?.[0]?.name || "").toLowerCase().trim();
      const assignedLower = String(task.assigned_to || "").toLowerCase().trim();

      if (callerRole === "board_member") {
        // Block if task is assigned to the owner. Post-rebuild: owner's
        // name lives on public.users where role='owner' for this tenant.
        const ownerNameRow = await pg.query(
          `SELECT name FROM public.users
            WHERE tenant_id = $1 AND role = 'owner' LIMIT 1`,
          [tenantId]
        );
        const ownerName = String(ownerNameRow?.rows?.[0]?.name || "").toLowerCase().trim();
        if (ownerName && assignedLower === ownerName) {
          return jsonErr(res, 403, "PERMISSION_DENIED", "Board members cannot edit the owner's tasks.");
        }
      } else {
        // Employee — must be assigned to themselves.
        if (!callerName || callerName !== assignedLower) {
          return jsonErr(res, 403, "PERMISSION_DENIED", "You can only complete your own tasks.");
        }
      }
    }

    const upd = await pg.query(
      `UPDATE public.tasks
          SET status = $1, updated_at = NOW()
        WHERE owner_id = $2 AND id = $3
        RETURNING id, status`,
      [newStatus, ownerId, taskId]
    );
    if (!upd.rowCount) {
      return jsonErr(res, 404, "NOT_FOUND", "Task not found.");
    }

    console.info("[TIMECLOCK_TASK_PATCH]", {
      callerRole,
      taskId,
      action,
    });
    return res.json({ ok: true, task: upd.rows[0] });
  } catch (e) {
    console.error("[TIMECLOCK] task patch error:", e?.message || e);
    return jsonErr(res, 500, "TASK_PATCH_FAILED", "Could not update task.");
  }
});

module.exports = router;
