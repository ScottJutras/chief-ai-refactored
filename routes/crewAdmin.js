// routes/crewAdmin.js
//
// F1 — Rebuild crew identity model.
// Members live in chiefos_portal_users (status from P1A-6) joined to
// public.users (auth_user_id link from P1A-4) for contact info. Role changes
// audit to chiefos_role_audit (Decision 12 / FOUNDATION §3.11). Non-role
// mutations emit via emitActivityLog. Pre-rebuild actor cluster (chiefos_actors,
// chiefos_tenant_actors, chiefos_actor_identities, chiefos_tenant_actor_profiles,
// chiefos_board_assignments) is no longer referenced.

const express = require("express");
const pg = require("../services/postgres");
const { requirePortalUser } = require("../middleware/requirePortalUser");
const { sendSMS } = require("../services/twilio");
const { sendEmail } = require("../services/postmark");
const { getAdminClient } = require("../services/supabaseAdmin");
const { generatePhoneLinkOtp } = require("../services/phoneLinkOtp");
const { emitActivityLog } = require("../services/activityLog");
const { buildActorContext } = require("../services/actorContext");

const router = express.Router();

// ============================================================================
// Plan limits — keyed off chiefos_portal_users.role enum
// ============================================================================
const PLAN_LIMITS = {
  free:    { employee: 3,  board_member: 0 },
  starter: { employee: 10, board_member: 0 },
  pro:     { employee: 50, board_member: 5 },
};

// ============================================================================
// Helpers
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^\d+$/;

function jsonErr(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, code, message, ...extra });
}

function DIGITS(x) { return String(x ?? "").replace(/\D/g, ""); }

function normalizePhoneDigits(input) {
  const d = DIGITS(input || "");
  if (!d) return "";
  if (d.length === 10) return "1" + d;
  if (d.length === 11 && d.startsWith("1")) return d;
  return d;
}

function isUuid(v) { return typeof v === "string" && UUID_RE.test(v); }
function isPhoneId(v) { return typeof v === "string" && DIGITS_RE.test(v) && v.length >= 7; }

function mustCtx(req) {
  const tenantId = String(req.tenantId || "").trim();
  const portalUserId = String(req.portalUserId || "").trim();
  const ownerId = String(req.ownerId || "").trim();
  const role = String(req.portalRole || "").trim();

  if (!tenantId || !portalUserId) {
    const err = new Error("Access not resolved. Please re-authenticate.");
    err.code = "TENANT_CTX_MISSING";
    throw err;
  }

  return { tenantId, portalUserId, ownerId, role };
}

function mustOwner(role) {
  if (role !== "owner") {
    const err = new Error("Owner-only action.");
    err.code = "PERMISSION_DENIED";
    throw err;
  }
}

async function getPlanKey(ownerId, client) {
  if (!ownerId) return "free";
  const r = await client.query(
    `select plan_key from public.users where user_id = $1 and owner_id = $1 limit 1`,
    [ownerId]
  );
  return String(r?.rows?.[0]?.plan_key || "free").trim().toLowerCase();
}

async function assertLimits({ tenantId, planKey = "free" }, client, { addingRole = null } = {}) {
  if (!addingRole) return;
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.free;

  const counts = await client.query(
    `
    select role, count(*)::int as n
      from public.chiefos_portal_users
     where tenant_id = $1::uuid
       and status = 'active'
     group by role
    `,
    [tenantId]
  );
  const map = new Map(counts.rows.map((r) => [r.role, r.n]));
  const employees = map.get("employee") || 0;
  const board = map.get("board_member") || 0;

  if (addingRole === "employee" && employees >= limits.employee) {
    const err = new Error(`Employee limit reached (${limits.employee} on ${planKey} plan). Upgrade to add more.`);
    err.code = "EMPLOYEE_LIMIT"; err.plan_key = planKey; err.limit = limits.employee;
    throw err;
  }
  if (addingRole === "board_member" && board >= limits.board_member) {
    const err = new Error(limits.board_member === 0
      ? `Board members require Pro.`
      : `Board member limit reached (${limits.board_member} on ${planKey} plan).`);
    err.code = "BOARD_LIMIT"; err.plan_key = planKey; err.limit = limits.board_member;
    throw err;
  }
}

// Block any change that would leave the tenant with 0 active owners.
async function assertActiveOwnersAfterChange({ tenantId, targetUserId }, client) {
  const r = await client.query(
    `
    select count(*)::int as n
      from public.chiefos_portal_users
     where tenant_id = $1::uuid
       and role = 'owner'
       and status = 'active'
       and user_id <> $2::uuid
    `,
    [tenantId, targetUserId]
  );
  if ((r.rows?.[0]?.n || 0) < 1) {
    const err = new Error("Cannot leave tenant without an active owner.");
    err.code = "OWNERLESS_BLOCKED";
    throw err;
  }
}

function deriveRoleAuditAction(prev, next) {
  const RANK = { owner: 3, board_member: 2, employee: 1 };
  const a = RANK[prev] ?? 0, b = RANK[next] ?? 0;
  if (b > a) return "promote";
  return "demote";
}

// Generate a Supabase magic link for the invite redirect (kept from prior impl —
// non-fatal helper for invite delivery).
async function generateInviteMagicLink({ email, appBase, token }) {
  try {
    const client = getAdminClient();
    if (!client) return null;
    const redirectTo = `${appBase}/invite/${token}`;
    const { data, error } = await client.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo },
    });
    if (error) {
      console.warn("[CREW_INVITE] generateLink failed:", error.message);
      return null;
    }
    return data?.properties?.action_link || null;
  } catch (e) {
    console.warn("[CREW_INVITE] generateLink exception:", e?.message || e);
    return null;
  }
}

// ============================================================================
// 1. GET /api/crew/admin/members
// ============================================================================
router.get("/admin/members", requirePortalUser(), async (req, res) => {
  try {
    const { tenantId, ownerId, role } = mustCtx(req);
    mustOwner(role);

    const out = await pg.withClient(async (client) => {
      const planKey = await getPlanKey(ownerId, client);
      const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.free;

      const portalRows = await client.query(
        `
        select
          pu.user_id::text  as actor_id,
          pu.role           as portal_role,
          pu.status         as status,
          pu.created_at     as created_at,
          u.user_id         as phone_digits,
          u.name            as display_name,
          u.email           as email,
          u.role            as ingestion_role
        from public.chiefos_portal_users pu
        left join public.users u
          on u.auth_user_id = pu.user_id
         and u.tenant_id    = pu.tenant_id
        where pu.tenant_id = $1::uuid
        order by
          case pu.role
            when 'owner' then 0
            when 'board_member' then 1
            else 2 end,
          pu.created_at asc
        `,
        [tenantId]
      );

      const orphanRows = await client.query(
        `
        select
          u.user_id          as actor_id,
          null::text         as portal_role,
          'active'::text     as status,
          u.created_at       as created_at,
          u.user_id          as phone_digits,
          u.name             as display_name,
          u.email            as email,
          u.role             as ingestion_role
        from public.users u
        where u.tenant_id = $1::uuid
          and u.auth_user_id is null
          and u.user_id <> u.owner_id
        order by u.created_at asc
        `,
        [tenantId]
      );

      const items = [...portalRows.rows, ...orphanRows.rows];
      const employees = items.filter((i) => i.portal_role === "employee" && i.status === "active").length;
      const board = items.filter((i) => i.portal_role === "board_member" && i.status === "active").length;

      return {
        items,
        quota: {
          plan_key: planKey,
          employees_used: employees,
          employees_limit: limits.employee,
          board_used: board,
          board_limit: limits.board_member,
        },
      };
    });

    return res.json({ ok: true, items: out.items, quota: out.quota });
  } catch (e) {
    const code = e?.code || "MEMBERS_FAILED";
    const status = code === "TENANT_CTX_MISSING" ? 403 : code === "PERMISSION_DENIED" ? 403 : 500;
    console.error("[CREW_ADMIN] members error", e?.message || e);
    return jsonErr(res, status, code, "Unable to load members.");
  }
});

// ============================================================================
// 2. POST /api/crew/admin/members
// Creates a public.users row (WhatsApp ingestion identity). Role limited to
// {employee, contractor} per public.users CHECK. Use POST /admin/invite for
// portal-only members (board_member, employees needing portal sign-up).
// ============================================================================
router.post("/admin/members", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const { tenantId, ownerId, role } = mustCtx(req);
    mustOwner(role);

    const displayName = String(req.body?.display_name || req.body?.name || "").trim();
    const phoneDigits = normalizePhoneDigits(req.body?.phone || "");
    const email = String(req.body?.email || "").trim().toLowerCase();
    const ingestionRole = String(req.body?.role || "employee").trim().toLowerCase();

    if (!displayName) return jsonErr(res, 400, "MISSING_NAME", "Display name is required.");
    if (!phoneDigits) return jsonErr(res, 400, "MISSING_PHONE", "Phone digits required (used as ingestion user_id).");
    if (!(phoneDigits.length === 11 && phoneDigits.startsWith("1"))) {
      return jsonErr(res, 400, "INVALID_PHONE", "Phone must be 10 digits (Canada/US) or include country code (e.g., 1XXXXXXXXXX).");
    }
    if (!["employee", "contractor"].includes(ingestionRole)) {
      return jsonErr(res, 400, "INVALID_ROLE", "role must be 'employee' or 'contractor'. Use POST /admin/invite for portal-only board_member.");
    }

    const out = await pg.withClient(async (client) => {
      const planKey = await getPlanKey(ownerId, client);
      await assertLimits({ tenantId, planKey }, client, { addingRole: "employee" });

      // Idempotent reuse: same phone, same tenant returns the existing row.
      const sameTenantHit = await client.query(
        `select user_id, name, email, role from public.users where user_id = $1 and tenant_id = $2::uuid and owner_id = $3 limit 1`,
        [phoneDigits, tenantId, ownerId]
      );
      if (sameTenantHit.rowCount) {
        const r = sameTenantHit.rows[0];
        return {
          actor_id: r.user_id,
          display_name: r.name,
          phone_digits: phoneDigits,
          email: r.email,
          role: r.role,
          reused: true,
        };
      }

      // Insert. The DB enforces the global PK uniqueness on user_id; on
      // collision we know this phone is taken by a different tenant.
      let ins;
      try {
        ins = await client.query(
          `
          insert into public.users
            (user_id, owner_id, tenant_id, name, email, role, plan_key, signup_status, created_at, updated_at)
          values
            ($1, $2, $3::uuid, $4, $5, $6, $7, 'pending_auth', now(), now())
          returning user_id, name, email, role, created_at
          `,
          [phoneDigits, ownerId, tenantId, displayName, email || null, ingestionRole, planKey]
        );
      } catch (e) {
        if (e?.code === "23505") {
          const err = new Error("This phone is already registered to a different tenant.");
          err.code = "PHONE_TAKEN";
          throw err;
        }
        throw e;
      }
      const row = ins.rows[0];

      await emitActivityLog(buildActorContext(req), {
        action_kind: "create",
        target_table: "users",
        target_id: row.user_id,
        target_kind: "crew_member",
        payload: { display_name: row.name, role: row.role, has_email: !!row.email },
      });

      return {
        actor_id: row.user_id,
        display_name: row.name,
        phone_digits: phoneDigits,
        email: row.email,
        role: row.role,
        created_at: row.created_at,
        reused: false,
      };
    });

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "CREATE_MEMBER_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "EMPLOYEE_LIMIT" ? 402 :
      code === "PHONE_TAKEN" ? 409 :
      500;
    console.error("[CREW_ADMIN] create member error", e?.message || e);
    const msg = code === "EMPLOYEE_LIMIT"
      ? (e?.message || "Employee limit reached.")
      : (e?.message || "Unable to add employee.");
    return jsonErr(res, status, code, msg, code === "EMPLOYEE_LIMIT" ? { plan_key: e?.plan_key, limit: e?.limit } : {});
  }
});

// ============================================================================
// 3. PATCH /api/crew/admin/members/:actorId
// Update name/email on the public.users row tied to this member.
// :actorId is a chiefos_portal_users.user_id (uuid) for portal-paired members,
// or a public.users.user_id (phone digits) for orphan WhatsApp-only members.
// Phone digits are immutable (they are the public.users PK).
// ============================================================================
router.patch("/admin/members/:actorId", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const { tenantId, portalUserId, role } = mustCtx(req);
    const targetActorId = String(req.params.actorId || "").trim();
    if (!targetActorId) return jsonErr(res, 400, "MISSING_TARGET", "Missing actorId.");

    const targetIsUuid = isUuid(targetActorId);
    const targetIsPhone = isPhoneId(targetActorId);
    if (!targetIsUuid && !targetIsPhone) {
      return jsonErr(res, 400, "INVALID_ACTOR_ID", "actorId must be a uuid or digit-string.");
    }

    const hasName = Object.prototype.hasOwnProperty.call(req.body || {}, "display_name") ||
                    Object.prototype.hasOwnProperty.call(req.body || {}, "name");
    const hasPhone = Object.prototype.hasOwnProperty.call(req.body || {}, "phone");
    const hasEmail = Object.prototype.hasOwnProperty.call(req.body || {}, "email");
    if (!hasName && !hasPhone && !hasEmail) {
      return jsonErr(res, 400, "NO_FIELDS", "Nothing to update.");
    }

    const newName = hasName ? String(req.body.display_name ?? req.body.name ?? "").trim() : null;
    const newPhone = hasPhone ? normalizePhoneDigits(req.body.phone || "") : null;
    const newEmail = hasEmail ? String(req.body.email || "").trim().toLowerCase() : null;

    if (hasName && !newName) return jsonErr(res, 400, "MISSING_NAME", "Display name cannot be empty.");

    const out = await pg.withClient(async (client) => {
      // Resolve target → public.users row.
      let phoneUserId = null;
      let isSelfEdit = false;

      if (targetIsUuid) {
        if (targetActorId.toLowerCase() === portalUserId.toLowerCase()) isSelfEdit = true;
        const r = await client.query(
          `
          select u.user_id, u.name, u.email
            from public.users u
           where u.auth_user_id = $1::uuid
             and u.tenant_id    = $2::uuid
           limit 1
          `,
          [targetActorId, tenantId]
        );
        if (!r.rowCount) {
          const err = new Error("Member is not yet phone-paired; contact info has no public.users row to update.");
          err.code = "NOT_PAIRED";
          throw err;
        }
        phoneUserId = r.rows[0].user_id;
      } else {
        // phone-digit target — verify in tenant; self-edit if it maps to caller's auth uuid.
        const r = await client.query(
          `select u.user_id, u.auth_user_id from public.users u where u.user_id = $1 and u.tenant_id = $2::uuid limit 1`,
          [targetActorId, tenantId]
        );
        if (!r.rowCount) {
          const err = new Error("Member not found.");
          err.code = "NOT_FOUND";
          throw err;
        }
        phoneUserId = r.rows[0].user_id;
        if (r.rows[0].auth_user_id && String(r.rows[0].auth_user_id).toLowerCase() === portalUserId.toLowerCase()) {
          isSelfEdit = true;
        }
      }

      if (!isSelfEdit) mustOwner(role);

      if (hasPhone && newPhone && newPhone !== phoneUserId) {
        const err = new Error("Phone number cannot be changed (it is the ingestion user_id). Create a new member or contact support.");
        err.code = "PHONE_IMMUTABLE";
        throw err;
      }

      const cur = await client.query(
        `select user_id, name, email from public.users where user_id = $1 and tenant_id = $2::uuid limit 1`,
        [phoneUserId, tenantId]
      );
      const prev = cur.rows[0];
      const nextName = hasName ? newName : prev.name;
      const nextEmail = hasEmail ? (newEmail || null) : prev.email;

      await client.query(
        `update public.users set name = $1, email = $2, updated_at = now() where user_id = $3 and tenant_id = $4::uuid`,
        [nextName, nextEmail, phoneUserId, tenantId]
      );

      await emitActivityLog(buildActorContext(req), {
        action_kind: "update",
        target_table: "users",
        target_id: phoneUserId,
        target_kind: "crew_member",
        payload: {
          changed: { name: hasName, email: hasEmail },
          ...(hasName ? { new_name: nextName } : {}),
          ...(hasEmail ? { new_email: nextEmail } : {}),
        },
      });

      return {
        actor_id: targetActorId,
        phone_digits: phoneUserId,
        display_name: nextName,
        email: nextEmail,
      };
    });

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "UPDATE_MEMBER_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "NOT_FOUND" ? 404 :
      code === "NOT_PAIRED" ? 409 :
      code === "PHONE_IMMUTABLE" ? 409 :
      400;
    console.error("[CREW_ADMIN] update member error", e?.message || e);
    return jsonErr(res, status, code, e?.message || "Unable to update member.");
  }
});

// ============================================================================
// 4. PATCH /api/crew/admin/members/:actorId/role
// Change chiefos_portal_users.role. INSERTs chiefos_role_audit. Ownerless guard.
// ============================================================================
router.patch("/admin/members/:actorId/role", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const { tenantId, ownerId, portalUserId, role } = mustCtx(req);
    mustOwner(role);

    const targetUuid = String(req.params.actorId || "").trim();
    const newRole = String(req.body?.role || "").trim();
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : null;

    if (!isUuid(targetUuid)) {
      return jsonErr(res, 400, "INVALID_ACTOR_ID", "Role changes require a portal-paired user (uuid actorId).");
    }
    if (!["owner", "board_member", "employee"].includes(newRole)) {
      return jsonErr(res, 400, "INVALID_ROLE", "Role must be owner, board_member, or employee.");
    }
    if (targetUuid.toLowerCase() === portalUserId.toLowerCase() && newRole !== "owner") {
      return jsonErr(res, 409, "SELF_ROLE_CHANGE_BLOCKED", "You cannot change your own role here.");
    }

    const out = await pg.withClient(async (client) => {
      const cur = await client.query(
        `
        select user_id, role, status
          from public.chiefos_portal_users
         where tenant_id = $1::uuid and user_id = $2::uuid
         limit 1
        `,
        [tenantId, targetUuid]
      );
      if (!cur.rowCount) {
        const err = new Error("Member not found.");
        err.code = "NOT_FOUND";
        throw err;
      }
      const prev = cur.rows[0];
      const previousRole = prev.role;
      if (previousRole === newRole) {
        return { actor_id: targetUuid, role: newRole, action: "noop", changed: false };
      }

      if (newRole === "board_member") {
        const planKey = await getPlanKey(ownerId, client);
        await assertLimits({ tenantId, planKey }, client, { addingRole: "board_member" });
      }

      if (previousRole === "owner" && newRole !== "owner") {
        await assertActiveOwnersAfterChange({ tenantId, targetUserId: targetUuid }, client);
      }

      await client.query(
        `
        update public.chiefos_portal_users
           set role = $1
         where tenant_id = $2::uuid and user_id = $3::uuid
        `,
        [newRole, tenantId, targetUuid]
      );

      const action = deriveRoleAuditAction(previousRole, newRole);
      await client.query(
        `
        insert into public.chiefos_role_audit
          (tenant_id, owner_id, acted_by_portal_user_id, target_portal_user_id,
           previous_role, new_role, action, reason, correlation_id, created_at)
        values
          ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::uuid, now())
        `,
        [tenantId, ownerId, portalUserId, targetUuid, previousRole, newRole, action, reason, req.correlationId]
      );

      return { actor_id: targetUuid, role: newRole, action, changed: true };
    });

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "UPDATE_ROLE_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "NOT_FOUND" ? 404 :
      code === "BOARD_LIMIT" ? 409 :
      code === "OWNERLESS_BLOCKED" ? 409 :
      500;
    console.error("[CREW_ADMIN] role error", e?.message || e);
    return jsonErr(res, status, code, e?.message || "Unable to update role.",
      code === "BOARD_LIMIT" ? { plan_key: e?.plan_key, limit: e?.limit } : {}
    );
  }
});

// ============================================================================
// 5. DELETE /api/crew/admin/members/:actorId — soft-delete
// Sets chiefos_portal_users.status='deactivated'. Emits emitActivityLog.
// Ownerless guard. Self-deactivate blocked.
// ============================================================================
router.delete("/admin/members/:actorId", requirePortalUser(), async (req, res) => {
  try {
    const { tenantId, portalUserId, role } = mustCtx(req);
    mustOwner(role);

    const targetUuid = String(req.params.actorId || "").trim();
    if (!isUuid(targetUuid)) {
      return jsonErr(res, 400, "INVALID_ACTOR_ID", "Deactivation requires a portal-paired user (uuid actorId).");
    }
    if (targetUuid.toLowerCase() === portalUserId.toLowerCase()) {
      return jsonErr(res, 409, "SELF_DELETE_BLOCKED", "You cannot deactivate yourself.");
    }

    const out = await pg.withClient(async (client) => {
      const cur = await client.query(
        `
        select user_id, role, status
          from public.chiefos_portal_users
         where tenant_id = $1::uuid and user_id = $2::uuid
         limit 1
        `,
        [tenantId, targetUuid]
      );
      if (!cur.rowCount) {
        const err = new Error("Member not found.");
        err.code = "NOT_FOUND";
        throw err;
      }
      const prev = cur.rows[0];
      if (prev.status === "deactivated") {
        return { actor_id: targetUuid, status: "deactivated", changed: false };
      }
      if (prev.role === "owner") {
        await assertActiveOwnersAfterChange({ tenantId, targetUserId: targetUuid }, client);
      }

      await client.query(
        `
        update public.chiefos_portal_users
           set status = 'deactivated'
         where tenant_id = $1::uuid and user_id = $2::uuid
        `,
        [tenantId, targetUuid]
      );

      await emitActivityLog(buildActorContext(req), {
        action_kind: "update",
        target_table: "chiefos_portal_users",
        target_id: targetUuid,
        target_kind: "deactivate",
        payload: { previous_status: prev.status, new_status: "deactivated", role: prev.role },
      });

      return { actor_id: targetUuid, status: "deactivated", changed: true };
    });

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "DELETE_MEMBER_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "NOT_FOUND" ? 404 :
      code === "SELF_DELETE_BLOCKED" ? 409 :
      code === "OWNERLESS_BLOCKED" ? 409 :
      500;
    console.error("[CREW_ADMIN] delete member error", e?.message || e);
    return jsonErr(res, status, code, e?.message || "Unable to deactivate member.");
  }
});

// ============================================================================
// 6. POST /api/crew/admin/members/:actorId/reactivate
// Sets chiefos_portal_users.status='active'. Emits emitActivityLog.
// ============================================================================
router.post("/admin/members/:actorId/reactivate", requirePortalUser(), async (req, res) => {
  try {
    const { tenantId, role } = mustCtx(req);
    mustOwner(role);

    const targetUuid = String(req.params.actorId || "").trim();
    if (!isUuid(targetUuid)) {
      return jsonErr(res, 400, "INVALID_ACTOR_ID", "Reactivation requires a portal-paired user (uuid actorId).");
    }

    const out = await pg.withClient(async (client) => {
      const cur = await client.query(
        `
        select user_id, role, status
          from public.chiefos_portal_users
         where tenant_id = $1::uuid and user_id = $2::uuid
         limit 1
        `,
        [tenantId, targetUuid]
      );
      if (!cur.rowCount) {
        const err = new Error("Member not found.");
        err.code = "NOT_FOUND";
        throw err;
      }
      const prev = cur.rows[0];
      if (prev.status === "active") {
        return { actor_id: targetUuid, status: "active", changed: false };
      }

      await client.query(
        `
        update public.chiefos_portal_users
           set status = 'active'
         where tenant_id = $1::uuid and user_id = $2::uuid
        `,
        [tenantId, targetUuid]
      );

      await emitActivityLog(buildActorContext(req), {
        action_kind: "update",
        target_table: "chiefos_portal_users",
        target_id: targetUuid,
        target_kind: "reactivate",
        payload: { previous_status: prev.status, new_status: "active", role: prev.role },
      });

      return { actor_id: targetUuid, status: "active", changed: true };
    });

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "REACTIVATE_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "NOT_FOUND" ? 404 :
      500;
    console.error("[CREW_ADMIN] reactivate error", e?.message || e);
    return jsonErr(res, status, code, e?.message || "Unable to reactivate member.");
  }
});

// ============================================================================
// 7. POST /api/crew/admin/members/:actorId/phone-link-otp
// Owner triggers a phone-link OTP for a portal-paired member. Returns the
// 6-digit code to the owner so they can relay it (or pre-send via SMS if
// body.deliver === 'sms').
// ============================================================================
router.post("/admin/members/:actorId/phone-link-otp", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const { tenantId, role } = mustCtx(req);
    mustOwner(role);

    const targetUuid = String(req.params.actorId || "").trim();
    if (!isUuid(targetUuid)) {
      return jsonErr(res, 400, "INVALID_ACTOR_ID", "OTP requires a portal-paired user (uuid actorId).");
    }
    const deliver = String(req.body?.deliver || "").trim().toLowerCase();

    const member = await pg.query(
      `select 1 from public.chiefos_portal_users where tenant_id = $1::uuid and user_id = $2::uuid limit 1`,
      [tenantId, targetUuid]
    );
    if (!member.rowCount) return jsonErr(res, 404, "NOT_FOUND", "Member not found in this tenant.");

    let phoneDigits = normalizePhoneDigits(req.body?.phone || "");
    if (!phoneDigits) {
      const r = await pg.query(
        `select user_id from public.users where auth_user_id = $1::uuid and tenant_id = $2::uuid limit 1`,
        [targetUuid, tenantId]
      );
      phoneDigits = r.rows?.[0]?.user_id || "";
    }
    if (!phoneDigits) {
      return jsonErr(res, 409, "NO_PHONE", "No phone digits available for this member; provide phone in body or pre-create the public.users row.");
    }
    if (!(phoneDigits.length >= 7 && /^\d+$/.test(phoneDigits))) {
      return jsonErr(res, 400, "INVALID_PHONE", "Invalid phone digits.");
    }

    const { code, expiresAt } = await generatePhoneLinkOtp(targetUuid, phoneDigits);

    let smsOk = null;
    let smsError = null;
    if (deliver === "sms") {
      try {
        await sendSMS("+" + phoneDigits, `Your ChiefOS phone-link code: ${code}\nReply with this code from WhatsApp to pair your phone.`);
        smsOk = true;
      } catch (e) {
        smsOk = false;
        smsError = String(e?.message || "SMS delivery failed");
      }
    }

    return res.json({
      ok: true,
      item: {
        actor_id: targetUuid,
        phone_digits: phoneDigits,
        code,
        expires_at: expiresAt,
        ...(deliver === "sms" ? { sms_ok: smsOk, sms_error: smsError } : {}),
      },
    });
  } catch (e) {
    const code = e?.code || "OTP_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      500;
    console.error("[CREW_ADMIN] phone-link-otp error", e?.message || e);
    return jsonErr(res, status, code, e?.message || "Unable to generate phone-link OTP.");
  }
});

// ============================================================================
// 8. GET /api/crew/admin/members/export.csv
// ============================================================================
router.get("/admin/members/export.csv", requirePortalUser(), async (req, res) => {
  try {
    const { tenantId, role } = mustCtx(req);
    mustOwner(role);

    const rows = await pg.withClient(async (client) => {
      const r = await client.query(
        `
        select
          pu.user_id::text         as actor_id,
          pu.role                  as portal_role,
          pu.status                as status,
          pu.created_at            as created_at,
          coalesce(u.user_id, '')  as phone_digits,
          coalesce(u.name, '')     as display_name,
          coalesce(u.email, '')    as email
        from public.chiefos_portal_users pu
        left join public.users u
          on u.auth_user_id = pu.user_id
         and u.tenant_id    = pu.tenant_id
        where pu.tenant_id = $1::uuid
        union all
        select
          u.user_id                as actor_id,
          ''::text                 as portal_role,
          'active'::text           as status,
          u.created_at             as created_at,
          u.user_id                as phone_digits,
          coalesce(u.name, '')     as display_name,
          coalesce(u.email, '')    as email
        from public.users u
        where u.tenant_id = $1::uuid
          and u.auth_user_id is null
          and u.user_id <> u.owner_id
        order by created_at asc
        `,
        [tenantId]
      );
      return r.rows || [];
    });

    const esc = (v) => {
      const s = String(v ?? "");
      if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const header = ["actor_id", "portal_role", "status", "display_name", "phone_digits", "email", "created_at"];
    const lines = [
      header.join(","),
      ...rows.map((r) =>
        [esc(r.actor_id), esc(r.portal_role), esc(r.status), esc(r.display_name), esc(r.phone_digits), esc(r.email), esc(r.created_at)].join(",")
      ),
    ];

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="crew_members_${tenantId}.csv"`);
    return res.status(200).send(lines.join("\n"));
  } catch (e) {
    const code = e?.code || "EXPORT_FAILED";
    const status = code === "PERMISSION_DENIED" ? 403 : 500;
    console.error("[CREW_ADMIN] export error", e?.message || e);
    return jsonErr(res, status, code, "Unable to export members.");
  }
});

// ============================================================================
// 9. POST /api/crew/admin/invite
// Creates an employee_invites row + sends invite via SMS / email / WhatsApp.
// invited_role limited to {employee, board_member} per rebuild CHECK.
// ============================================================================
router.post("/admin/invite", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const { tenantId, ownerId, portalUserId, role } = mustCtx(req);
    mustOwner(role);

    const employeeName = String(req.body?.employee_name || "").trim();
    const rawPhone = String(req.body?.phone || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const invitedRole = String(req.body?.role || "employee").trim().toLowerCase();
    const deliveryMethod = String(req.body?.delivery_method || "sms").trim().toLowerCase();

    if (!employeeName) return jsonErr(res, 400, "MISSING_NAME", "Employee name is required.");
    if (!rawPhone && !email) return jsonErr(res, 400, "MISSING_CONTACT", "Phone or email is required to send invite.");
    if (!["employee", "board_member"].includes(invitedRole)) {
      return jsonErr(res, 400, "INVALID_ROLE", "invited role must be 'employee' or 'board_member'.");
    }

    const phoneDigits = normalizePhoneDigits(rawPhone);
    if (rawPhone && !(phoneDigits.length === 11 && phoneDigits.startsWith("1"))) {
      return jsonErr(res, 400, "INVALID_PHONE", "Phone must be 10 digits (Canada/US) or include country code.");
    }

    const out = await pg.withClient(async (client) => {
      if (invitedRole === "board_member") {
        const planKey = await getPlanKey(ownerId, client);
        await assertLimits({ tenantId, planKey }, client, { addingRole: "board_member" });
      }

      const r = await client.query(
        `
        insert into public.employee_invites
          (tenant_id, owner_id, invited_by_portal_user_id,
           employee_name, invite_phone, invite_email, invited_role)
        values
          ($1::uuid, $2, $3::uuid, $4, $5, $6, $7)
        returning id, token, expires_at
        `,
        [tenantId, ownerId, portalUserId, employeeName, phoneDigits || null, email || null, invitedRole]
      );

      const inviteRow = r.rows[0];

      await emitActivityLog(buildActorContext(req), {
        action_kind: "create",
        target_table: "employee_invites",
        target_id: inviteRow.id,
        target_kind: "invite",
        payload: { employee_name: employeeName, invited_role: invitedRole, has_phone: !!phoneDigits, has_email: !!email },
      });

      return inviteRow;
    });

    const appBase = String(process.env.APP_BASE_URL || "https://app.usechiefos.com").replace(/\/$/, "");
    const inviteUrl = `${appBase}/invite/${out.token}`;
    const inviteMsg = `You've been invited to join ChiefOS. Tap to get started:\n${inviteUrl}\n\nLink expires in 7 days.`;

    let deliveryOk = false;
    let deliveryError = null;

    if (deliveryMethod === "sms" && phoneDigits) {
      try {
        await sendSMS("+" + phoneDigits, inviteMsg);
        deliveryOk = true;
      } catch (e) {
        deliveryError = String(e?.message || "SMS delivery failed");
        console.warn("[CREW_INVITE] SMS send failed:", deliveryError);
      }
    } else if (deliveryMethod === "email" && email) {
      try {
        const magicLink = await generateInviteMagicLink({ email, appBase, token: out.token });
        const buttonHref = magicLink || inviteUrl;

        await sendEmail({
          to: email,
          replyTo: "hello@usechiefos.com",
          subject: "You've been invited to ChiefOS",
          textBody: `You've been invited to join ChiefOS. Tap to get started:\n${buttonHref}\n\nLink expires in 7 days.`,
          htmlBody: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 16px">
              <p style="font-size:20px;font-weight:600;color:#111">You've been invited to join ChiefOS</p>
              <p style="color:#555">Tap the button below to get started. The link expires in 7 days.</p>
              <a href="${buttonHref}"
                 style="display:inline-block;margin-top:16px;padding:12px 24px;background:#D4A853;color:#0C0B0A;font-weight:600;border-radius:10px;text-decoration:none">
                Accept invite
              </a>
              <p style="margin-top:24px;color:#999;font-size:12px">
                Or copy this link: <a href="${buttonHref}" style="color:#D4A853">${buttonHref}</a>
              </p>
            </div>
          `,
        });
        deliveryOk = true;
      } catch (e) {
        deliveryError = String(e?.message || "Email delivery failed");
        console.warn("[CREW_INVITE] Email send failed:", deliveryError);
      }
    }

    return res.json({
      ok: true,
      item: {
        id: out.id,
        token: out.token,
        inviteUrl,
        expires_at: out.expires_at,
        deliveryMethod,
        deliveryOk,
        deliveryError,
      },
    });
  } catch (e) {
    const code = e?.code || "CREATE_INVITE_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "BOARD_LIMIT" ? 409 :
      500;
    console.error("[CREW_INVITE] create error", e?.message || e);
    return jsonErr(res, status, code, e?.message || "Unable to create invite.",
      code === "BOARD_LIMIT" ? { plan_key: e?.plan_key, limit: e?.limit } : {}
    );
  }
});

// ============================================================================
// 10. GET /api/crew/admin/invites
// ============================================================================
router.get("/admin/invites", requirePortalUser(), async (req, res) => {
  try {
    const { tenantId, role } = mustCtx(req);
    mustOwner(role);

    const out = await pg.withClient(async (client) => {
      const r = await client.query(
        `
        select
          id, token, employee_name,
          invite_phone  as phone,
          invite_email  as email,
          invited_role  as role,
          status, expires_at, accepted_at, created_at
        from public.employee_invites
        where tenant_id = $1::uuid
        order by created_at desc
        limit 50
        `,
        [tenantId]
      );
      return r.rows || [];
    });

    return res.json({ ok: true, items: out });
  } catch (e) {
    const code = e?.code || "LIST_INVITES_FAILED";
    const status = code === "TENANT_CTX_MISSING" ? 403 : code === "PERMISSION_DENIED" ? 403 : 500;
    console.error("[CREW_INVITE] list error", e?.message || e);
    return jsonErr(res, status, code, "Unable to list invites.");
  }
});

module.exports = router;
