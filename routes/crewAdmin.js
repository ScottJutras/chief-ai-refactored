// routes/crewAdmin.js
const express = require("express");
const crypto = require("crypto");
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
  const role = String(req.portalRole || "").trim();
  if (!tenantId || !actorId) {
    return { ok: false, status: 403, code: "TENANT_CTX_MISSING", message: "Access not resolved. Please re-authenticate." };
  }
  return { tenantId, actorId, ownerId, role };
}

function DIGITS(x) {
  return String(x ?? "").replace(/\D/g, "");
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

function mustOwnerOrAdmin(role) {
  if (role !== "owner" && role !== "admin") {
    const err = new Error("Permission denied");
    err.code = "PERMISSION_DENIED";
    throw err;
  }
}

async function assertLimits({ tenantId }, client, { addingRole = null } = {}) {
  const counts = await client.query(
    `
    select
      sum(case when role = 'employee' then 1 else 0 end)::int as employees,
      sum(case when role = 'board' then 1 else 0 end)::int as board
    from public.chiefos_tenant_actors
    where tenant_id = $1
    `,
    [tenantId]
  );

  const employees = counts.rows?.[0]?.employees ?? 0;
  const board = counts.rows?.[0]?.board ?? 0;

  if (addingRole === "employee" && employees >= 150) {
    const err = new Error("Employee limit reached");
    err.code = "EMPLOYEE_LIMIT";
    throw err;
  }
  if (addingRole === "board" && board >= 25) {
    const err = new Error("Board member limit reached");
    err.code = "BOARD_LIMIT";
    throw err;
  }
}

/**
 * GET /api/crew/admin/members
 * Owner/admin view of all actors + profiles.
 */
router.get("/admin/members", requirePortalUser, requireCrewControlPro(), async (req, res) => {
  try {
    const { tenantId, actorId } = mustCtx(req);

    const out = await pg.withClient(async (client) => {
      const role = await getActorRole({ tenantId, actorId }, client);
      mustOwnerOrAdmin(role);

      const r = await client.query(
        `
        select
          a.actor_id,
          a.role,
          a.created_at,
          p.display_name,
          p.phone_digits,
          p.email
        from public.chiefos_tenant_actors a
        left join public.chiefos_tenant_actor_profiles p
          on p.tenant_id = a.tenant_id
         and p.actor_id = a.actor_id
        where a.tenant_id = $1
        order by
          case a.role when 'owner' then 0 when 'admin' then 1 when 'board' then 2 else 3 end,
          a.created_at asc
        `,
        [tenantId]
      );

      return r.rows || [];
    });

    return res.json({ ok: true, items: out });
  } catch (e) {
    const code = e?.code || "MEMBERS_FAILED";
    const status = code === "PERMISSION_DENIED" ? 403 : 500;
    console.error("[CREW_ADMIN] members error", e?.message || e);
    return jsonErr(res, status, code, "Unable to load members.");
  }
});

/**
 * POST /api/crew/admin/members
 * Body: { display_name, phone, email }
 * Creates an employee actor + profile.
 */
router.post("/admin/members", requirePortalUser, requireCrewControlPro(), express.json(), async (req, res) => {
  try {
    const { tenantId, actorId } = mustCtx(req);
    const displayName = String(req.body?.display_name || "").trim();
    const phoneDigits = DIGITS(req.body?.phone || "");
    const email = String(req.body?.email || "").trim().toLowerCase();

    if (!displayName) return jsonErr(res, 400, "MISSING_NAME", "Display name is required.");
    if (!phoneDigits && !email) return jsonErr(res, 400, "MISSING_CONTACT", "Phone or email is required.");

    const out = await pg.withClient(async (client) => {
      const role = await getActorRole({ tenantId, actorId }, client);
      mustOwnerOrAdmin(role);

      await assertLimits({ tenantId }, client, { addingRole: "employee" });

      // create new actor_id
      const newActorId = crypto.randomUUID();

      await client.query(
        `
        insert into public.chiefos_tenant_actors (tenant_id, actor_id, role)
        values ($1, $2, 'employee')
        `,
        [tenantId, newActorId]
      );

      await client.query(
        `
        insert into public.chiefos_tenant_actor_profiles (tenant_id, actor_id, display_name, phone_digits, email)
        values ($1,$2,$3,$4,$5)
        on conflict (tenant_id, actor_id) do update
          set display_name = excluded.display_name,
              phone_digits = excluded.phone_digits,
              email = excluded.email,
              updated_at = now()
        `,
        [tenantId, newActorId, displayName, phoneDigits || null, email || null]
      );

      return { actor_id: newActorId, role: "employee", display_name: displayName, phone_digits: phoneDigits || null, email: email || null };
    });

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "CREATE_MEMBER_FAILED";
    const status =
      code === "PERMISSION_DENIED" ? 403 :
      code === "EMPLOYEE_LIMIT" ? 409 :
      500;
    console.error("[CREW_ADMIN] create member error", e?.message || e);
    return jsonErr(res, status, code, "Unable to add employee.");
  }
});

/**
 * PATCH /api/crew/admin/members/:actorId/role
 * Body: { role: 'employee'|'board'|'admin' }
 * Owner/admin can promote/demote, with board cap enforced.
 */
router.patch("/admin/members/:actorId/role", requirePortalUser, requireCrewControlPro(), express.json(), async (req, res) => {
  try {
    const { tenantId, actorId } = mustCtx(req);
    const targetActorId = String(req.params.actorId || "").trim();
    const newRole = String(req.body?.role || "").trim();

    if (!targetActorId) return jsonErr(res, 400, "MISSING_TARGET", "Missing actorId.");
    if (!["employee", "board", "admin"].includes(newRole)) return jsonErr(res, 400, "INVALID_ROLE", "Invalid role.");

    const out = await pg.withClient(async (client) => {
      const role = await getActorRole({ tenantId, actorId }, client);
      mustOwnerOrAdmin(role);

      // don't allow changing self out of owner/admin via this endpoint (safety)
      if (targetActorId === actorId && newRole !== role) {
        const err = new Error("Cannot change your own role here");
        err.code = "SELF_ROLE_CHANGE_BLOCKED";
        throw err;
      }

      if (newRole === "board") {
        await assertLimits({ tenantId }, client, { addingRole: "board" });
      }

      const u = await client.query(
        `
        update public.chiefos_tenant_actors
           set role = $1
         where tenant_id = $2
           and actor_id = $3
         returning actor_id, role
        `,
        [newRole, tenantId, targetActorId]
      );

      if (!u?.rowCount) {
        const err = new Error("Member not found");
        err.code = "NOT_FOUND";
        throw err;
      }

      // If demoting from board, deactivate their assignments as board target
      if (newRole !== "board") {
        await client.query(
          `
          update public.chiefos_board_assignments
             set active = false
           where tenant_id = $1
             and board_actor_id = $2
          `,
          [tenantId, targetActorId]
        );
      }

      return u.rows[0];
    });

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "UPDATE_ROLE_FAILED";
    const status =
      code === "PERMISSION_DENIED" ? 403 :
      code === "BOARD_LIMIT" ? 409 :
      code === "NOT_FOUND" ? 404 :
      code === "SELF_ROLE_CHANGE_BLOCKED" ? 409 :
      500;
    console.error("[CREW_ADMIN] role error", e?.message || e);
    return jsonErr(res, status, code, "Unable to update role.");
  }
});

/**
 * POST /api/crew/admin/assign
 * Body: { employee_actor_id, board_actor_id }
 * Upserts assignment -> used by resolveReviewerActorId().
 */
router.post("/admin/assign", requirePortalUser, requireCrewControlPro(), express.json(), async (req, res) => {
  try {
    const { tenantId, actorId } = mustCtx(req);
    const employeeActorId = String(req.body?.employee_actor_id || "").trim();
    const boardActorId = String(req.body?.board_actor_id || "").trim();

    if (!employeeActorId || !boardActorId) return jsonErr(res, 400, "MISSING_FIELDS", "employee_actor_id and board_actor_id required.");

    const out = await pg.withClient(async (client) => {
      const role = await getActorRole({ tenantId, actorId }, client);
      mustOwnerOrAdmin(role);

      // sanity: both actors exist in tenant, and roles are correct-ish
      const chk = await client.query(
        `
        select actor_id, role
          from public.chiefos_tenant_actors
         where tenant_id = $1
           and actor_id in ($2, $3)
        `,
        [tenantId, employeeActorId, boardActorId]
      );

      const map = new Map(chk.rows.map(r => [r.actor_id, r.role]));
      if (!map.has(employeeActorId) || !map.has(boardActorId)) {
        const err = new Error("Actor not found in tenant");
        err.code = "NOT_FOUND";
        throw err;
      }
      if (map.get(boardActorId) !== "board" && map.get(boardActorId) !== "owner" && map.get(boardActorId) !== "admin") {
        const err = new Error("Target reviewer must be board/owner/admin");
        err.code = "INVALID_REVIEWER";
        throw err;
      }

      const u = await client.query(
        `
        insert into public.chiefos_board_assignments (tenant_id, employee_actor_id, board_actor_id, active)
        values ($1,$2,$3,true)
        on conflict (tenant_id, employee_actor_id)
        do update set board_actor_id = excluded.board_actor_id, active = true
        returning tenant_id, employee_actor_id, board_actor_id, active
        `,
        [tenantId, employeeActorId, boardActorId]
      );

      return u.rows[0];
    });

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "ASSIGN_FAILED";
    const status =
      code === "PERMISSION_DENIED" ? 403 :
      code === "NOT_FOUND" ? 404 :
      code === "INVALID_REVIEWER" ? 409 :
      500;
    console.error("[CREW_ADMIN] assign error", e?.message || e);
    return jsonErr(res, status, code, "Unable to assign employee to board.");
  }
});

module.exports = router;