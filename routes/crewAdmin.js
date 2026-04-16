// routes/crewAdmin.js
const express = require("express");
const crypto = require("crypto");
const pg = require("../services/postgres");
const { requirePortalUser } = require("../middleware/requirePortalUser");
const { sendSMS } = require("../services/twilio");
const { sendEmail } = require("../services/postmark");
const { getAdminClient } = require("../services/supabaseAdmin");

/**
 * Generate a Supabase magic link that, when clicked, hydrates a session and
 * redirects to the invite page with ?claim=1 so the auto-claim path runs.
 * Returns null on failure — caller should fall back to the bare invite URL.
 */
async function generateInviteMagicLink({ email, appBase, token }) {
  try {
    const client = getAdminClient();
    if (!client) return null;

    // Redirect straight to the invite page (no query params) so Supabase's
    // URL allowlist match is trivial — just needs app.usechiefos.com/**.
    // The invite page auto-claims when it detects a hydrated session.
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

const PLAN_LIMITS = {
  free:    { employees: 3,  board: 0, admin: 0 },
  starter: { employees: 10, board: 0, admin: 0 },  // board + admin are Pro-only
  pro:     { employees: 50, board: 5, admin: 1 },
};

async function getPlanKey(ownerId, client) {
  if (!ownerId) return "free";
  const reg = await client.query(
    `select to_regclass('public.users') as t_users,
            to_regclass('public.chiefos_users') as t_chiefos_users`
  );
  const tUsers = reg?.rows?.[0]?.t_users || null;
  const tChiefosUsers = reg?.rows?.[0]?.t_chiefos_users || null;
  let key = "free";
  if (tUsers) {
    const r = await client.query(
      `select plan_key from public.users where owner_id = $1 limit 1`,
      [ownerId]
    );
    key = r?.rows?.[0]?.plan_key || "free";
  } else if (tChiefosUsers) {
    const r = await client.query(
      `select plan_key from public.chiefos_users where owner_id = $1 limit 1`,
      [ownerId]
    );
    key = r?.rows?.[0]?.plan_key || "free";
  }
  return String(key || "free").trim().toLowerCase();
}

const router = express.Router();

function jsonErr(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, code, message, ...extra });
}

function mustCtx(req) {
  const tenantId = String(req.tenantId || "").trim();
  const actorId = String(req.actorId || "").trim();
  const ownerId = String(req.ownerId || "").trim();
  const role = String(req.portalRole || "").trim();

  if (!tenantId) {
    const err = new Error("Access not resolved. Please re-authenticate.");
    err.code = "TENANT_CTX_MISSING";
    throw err;
  }

  // actorId may be absent when the owner's email hasn't been linked in
  // chiefos_actor_identities yet. Owners/admins can proceed — their portalRole
  // (set by requirePortalUser from chiefos_portal_users) is the auth authority.
  if (!actorId && role !== "owner" && role !== "admin") {
    const err = new Error("Access not resolved. Please re-authenticate.");
    err.code = "TENANT_CTX_MISSING";
    throw err;
  }

  return { tenantId, actorId, ownerId, role };
}

function DIGITS(x) {
  return String(x ?? "").replace(/\D/g, "");
}

// Mirror UI behavior (Canada/US convenience)
function normalizePhoneDigits(input) {
  const d = DIGITS(input || "");
  if (!d) return "";
  if (d.length === 10) return "1" + d;
  if (d.length === 11 && d.startsWith("1")) return d;
  return d; // validation happens in route
}

async function getActorRole({ tenantId, actorId }, client) {
  if (!actorId) return null; // empty string would cause 22P02 UUID cast error
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

// Accepts actorRole (from chiefos_tenant_actors) with portalRole as fallback.
// portalRole is authoritative from chiefos_portal_users via requirePortalUser.
function mustOwnerOrAdmin(actorRole, portalRole = null) {
  const effective = actorRole || portalRole;
  if (effective !== "owner" && effective !== "admin") {
    const err = new Error("Permission denied");
    err.code = "PERMISSION_DENIED";
    throw err;
  }
}

async function assertLimits({ tenantId, planKey = "free" }, client, { addingRole = null } = {}) {
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.free;

  const counts = await client.query(
    `
    select
      sum(case when role = 'employee' then 1 else 0 end)::int as employees,
      sum(case when role = 'board' then 1 else 0 end)::int as board,
      sum(case when role = 'admin' then 1 else 0 end)::int as admin
    from public.chiefos_tenant_actors
    where tenant_id = $1
    `,
    [tenantId]
  );

  const employees = counts.rows?.[0]?.employees ?? 0;
  const board = counts.rows?.[0]?.board ?? 0;
  const admin = counts.rows?.[0]?.admin ?? 0;

  if (addingRole === "employee" && employees >= limits.employees) {
    const err = new Error(
      `Employee limit reached (${limits.employees} on ${planKey} plan). Upgrade to add more.`
    );
    err.code = "EMPLOYEE_LIMIT";
    err.plan_key = planKey;
    err.limit = limits.employees;
    throw err;
  }
  if (addingRole === "board" && board >= limits.board) {
    const err = new Error(
      limits.board === 0
        ? `Board members require Pro.`
        : `Board member limit reached (${limits.board} on ${planKey} plan).`
    );
    err.code = "BOARD_LIMIT";
    err.plan_key = planKey;
    err.limit = limits.board;
    throw err;
  }
  if (addingRole === "admin" && admin >= limits.admin) {
    const err = new Error(
      limits.admin === 0
        ? `Admin role requires the Pro plan.`
        : `Admin limit reached (${limits.admin} on ${planKey} plan).`
    );
    err.code = "ADMIN_LIMIT";
    err.plan_key = planKey;
    err.limit = limits.admin;
    throw err;
  }

  return { employees, board, admin, limits };
}

/**
 * Find an existing actor_id by identity so we don't create duplicates.
 * Supports whatsapp variants + email.
 */
async function findExistingActorId({ phoneDigits, email }, client) {
  if (phoneDigits) {
    const candidates = [
      phoneDigits,
      "+" + phoneDigits,
      "whatsapp:" + phoneDigits,
      "whatsapp:+" + phoneDigits,
    ];

    const r = await client.query(
      `
      select actor_id
      from public.chiefos_actor_identities
      where kind = 'whatsapp'
        and identifier = any($1::text[])
      limit 1
      `,
      [candidates]
    );

    const hit = r?.rows?.[0]?.actor_id || null;
    if (hit) return hit;
  }

  if (email) {
    const r2 = await client.query(
      `
      select actor_id
      from public.chiefos_actor_identities
      where kind = 'email'
        and identifier = $1
      limit 1
      `,
      [String(email).trim().toLowerCase()]
    );
    const hit2 = r2?.rows?.[0]?.actor_id || null;
    if (hit2) return hit2;
  }

  return null;
}

/**
 * Ensure owner profile rows exist so UI shows a name instead of "Unnamed Owner".
 * Uses chiefos_actors.display_name when available.
 */
async function ensureOwnerProfiles({ tenantId }, client) {
  await client.query(
    `
    insert into public.chiefos_tenant_actor_profiles (tenant_id, actor_id, display_name, phone_digits, email)
    select
      a.tenant_id,
      a.actor_id,
      coalesce(nullif(oa.display_name,''), 'Owner') as display_name,
      null::text as phone_digits,
      null::text as email
    from public.chiefos_tenant_actors a
    left join public.chiefos_actors oa
      on oa.id = a.actor_id
    where a.tenant_id = $1
      and a.role = 'owner'
    on conflict (tenant_id, actor_id) do update
      set display_name = coalesce(nullif(public.chiefos_tenant_actor_profiles.display_name,''), excluded.display_name),
          updated_at = now()
    `,
    [tenantId]
  );
}

/**
 * GET /api/crew/admin/members
 * Owner/admin view of all actors + profiles.
 */
router.get("/admin/members", requirePortalUser(), async (req, res) => {
  try {
    const { tenantId, actorId, ownerId } = mustCtx(req);

    const out = await pg.withClient(async (client) => {
      const actorRole = await getActorRole({ tenantId, actorId }, client);
      mustOwnerOrAdmin(actorRole, req.portalRole);

      await ensureOwnerProfiles({ tenantId }, client);

      const planKey = await getPlanKey(ownerId, client);
      const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.free;

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

      const items = r.rows || [];
      const employees_used = items.filter((i) => i.role === "employee").length;
      const board_used = items.filter((i) => i.role === "board").length;
      const admin_used = items.filter((i) => i.role === "admin").length;

      return {
        items,
        quota: {
          plan_key: planKey,
          employees_used,
          employees_limit: limits.employees,
          board_used,
          board_limit: limits.board,
          admin_used,
          admin_limit: limits.admin,
        },
      };
    });

    return res.json({ ok: true, items: out.items, quota: out.quota });
  } catch (e) {
    const code = e?.code || "MEMBERS_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      500;
    console.error("[CREW_ADMIN] members error", e?.message || e);
    return jsonErr(res, status, code, "Unable to load members.");
  }
});

/**
 * ✅ NEW
 * GET /api/crew/admin/assignments
 * Owner/admin fetches current reviewer routing (employee -> board/admin/owner).
 *
 * Returns: { ok: true, items: [{ employee_actor_id, board_actor_id, active }] }
 */
router.get("/admin/assignments", requirePortalUser(),async (req, res) => {
  try {
    const { tenantId, actorId } = mustCtx(req);

    const out = await pg.withClient(async (client) => {
      const actorRole = await getActorRole({ tenantId, actorId }, client);
      mustOwnerOrAdmin(actorRole, req.portalRole);

      const r = await client.query(
        `
        select
          employee_actor_id,
          board_actor_id,
          active
        from public.chiefos_board_assignments
        where tenant_id = $1
          and active = true
        `,
        [tenantId]
      );

      return r.rows || [];
    });

    return res.json({ ok: true, items: out });
  } catch (e) {
    const code = e?.code || "ASSIGNMENTS_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      500;
    console.error("[CREW_ADMIN] assignments error", e?.message || e);
    return jsonErr(res, status, code, "Unable to load assignments.");
  }
});

/**
 * POST /api/crew/admin/members
 * Body: { display_name, phone, email }
 * Creates (or reuses) an employee actor + membership + profile + identities.
 */
router.post("/admin/members", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const { tenantId, actorId, ownerId } = mustCtx(req);

    const displayName = String(req.body?.display_name || "").trim();
    const phoneDigits = normalizePhoneDigits(req.body?.phone || "");
    const email = String(req.body?.email || "").trim().toLowerCase();

    if (!displayName) return jsonErr(res, 400, "MISSING_NAME", "Display name is required.");
    if (!phoneDigits && !email) return jsonErr(res, 400, "MISSING_CONTACT", "Phone or email is required.");

    // Until you add a country selector, we fail closed for non-NANP
    if (phoneDigits && !(phoneDigits.length === 11 && phoneDigits.startsWith("1"))) {
      return jsonErr(
        res,
        400,
        "INVALID_PHONE",
        "Phone must be 10 digits (Canada/US) or include country code (e.g., 1XXXXXXXXXX)."
      );
    }

    const out = await pg.withClient(async (client) => {
      const actorRole = await getActorRole({ tenantId, actorId }, client);
      mustOwnerOrAdmin(actorRole, req.portalRole);

      const planKey = await getPlanKey(ownerId, client);
      await assertLimits({ tenantId, planKey }, client, { addingRole: "employee" });

      const existingActorId = await findExistingActorId({ phoneDigits, email }, client);
      const newActorId = existingActorId || crypto.randomUUID();

      await client.query(
        `
        insert into public.chiefos_actors (id, display_name, created_at, updated_at)
        values ($1, $2, now(), now())
        on conflict (id) do update
          set display_name = coalesce(nullif(public.chiefos_actors.display_name,''), excluded.display_name),
              updated_at = now()
        `,
        [newActorId, displayName]
      );

      await client.query(
        `
        insert into public.chiefos_tenant_actors (tenant_id, actor_id, role)
        values ($1, $2, 'employee')
        on conflict (tenant_id, actor_id) do nothing
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

      if (phoneDigits) {
        await client.query(
          `
          insert into public.chiefos_actor_identities (kind, identifier, actor_id, created_at, updated_at)
          values
            ('whatsapp', $1, $2, now(), now()),
            ('whatsapp', '+' || $1, $2, now(), now()),
            ('whatsapp', 'whatsapp:' || $1, $2, now(), now()),
            ('whatsapp', 'whatsapp:+' || $1, $2, now(), now())
          on conflict do nothing
          `,
          [phoneDigits, newActorId]
        );
      }

      if (email) {
        await client.query(
          `
          insert into public.chiefos_actor_identities (kind, identifier, actor_id, created_at, updated_at)
          values ('email', $1, $2, now(), now())
          on conflict do nothing
          `,
          [email, newActorId]
        );
      }

      await ensureOwnerProfiles({ tenantId }, client);

      const rr = await client.query(
        `
        select role
        from public.chiefos_tenant_actors
        where tenant_id = $1 and actor_id = $2
        limit 1
        `,
        [tenantId, newActorId]
      );

      const finalRole = rr?.rows?.[0]?.role || "employee";

      return {
        actor_id: newActorId,
        role: finalRole,
        display_name: displayName,
        phone_digits: phoneDigits || null,
        email: email || null,
        reused_actor: !!existingActorId,
      };
    });

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "CREATE_MEMBER_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "EMPLOYEE_LIMIT" ? 402 :
      500;
    console.error("[CREW_ADMIN] create member error", e?.message || e);
    const msg = code === "EMPLOYEE_LIMIT" ? (e?.message || "Employee limit reached.") : "Unable to add employee.";
    return jsonErr(res, status, code, msg, code === "EMPLOYEE_LIMIT" ? { plan_key: e?.plan_key, limit: e?.limit } : {});
  }
});

/**
 * PATCH /api/crew/admin/members/:actorId/role
 * Body: { role: 'employee'|'board'|'admin' }
 */
router.patch("/admin/members/:actorId/role", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const { tenantId, actorId, ownerId } = mustCtx(req);
    const targetActorId = String(req.params.actorId || "").trim();
    const newRole = String(req.body?.role || "").trim();

    if (!targetActorId) return jsonErr(res, 400, "MISSING_TARGET", "Missing actorId.");
    if (!["employee", "board", "admin"].includes(newRole)) return jsonErr(res, 400, "INVALID_ROLE", "Invalid role.");

    const out = await pg.withClient(async (client) => {
      const actorRole = await getActorRole({ tenantId, actorId }, client);
      mustOwnerOrAdmin(actorRole, req.portalRole);

      if (targetActorId === actorId && newRole !== role) {
        const err = new Error("Cannot change your own role here");
        err.code = "SELF_ROLE_CHANGE_BLOCKED";
        throw err;
      }

      if (newRole === "board" || newRole === "admin") {
        // Skip the limit check when the target is already in the requested
        // role (no-op reassign shouldn't trip the quota).
        const cur = await client.query(
          `select role from public.chiefos_tenant_actors
            where tenant_id = $1 and actor_id = $2 limit 1`,
          [tenantId, targetActorId]
        );
        const currentRole = cur.rows?.[0]?.role || null;
        if (currentRole !== newRole) {
          const planKey = await getPlanKey(ownerId, client);
          await assertLimits({ tenantId, planKey }, client, { addingRole: newRole });
        }
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

      await ensureOwnerProfiles({ tenantId }, client);

      return u.rows[0];
    });

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "UPDATE_ROLE_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "BOARD_LIMIT" ? 409 :
      code === "ADMIN_LIMIT" ? 409 :
      code === "NOT_FOUND" ? 404 :
      code === "SELF_ROLE_CHANGE_BLOCKED" ? 409 :
      500;
    console.error("[CREW_ADMIN] role error", e?.message || e);
    return jsonErr(res, status, code, e?.message || "Unable to update role.",
      (code === "BOARD_LIMIT" || code === "ADMIN_LIMIT") ? { plan_key: e?.plan_key, limit: e?.limit } : {}
    );
  }
});

/**
 * PATCH /api/crew/admin/members/:actorId
 * Body: { display_name?, phone?, email? }
 * Owner/admin updates contact info for a member (name/phone/email).
 */
router.patch("/admin/members/:actorId", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const { tenantId, actorId } = mustCtx(req);
    const targetActorId = String(req.params.actorId || "").trim();
    if (!targetActorId) return jsonErr(res, 400, "MISSING_TARGET", "Missing actorId.");

    const hasName = Object.prototype.hasOwnProperty.call(req.body || {}, "display_name");
    const hasPhone = Object.prototype.hasOwnProperty.call(req.body || {}, "phone");
    const hasEmail = Object.prototype.hasOwnProperty.call(req.body || {}, "email");
    if (!hasName && !hasPhone && !hasEmail) {
      return jsonErr(res, 400, "NO_FIELDS", "Nothing to update.");
    }

    const displayName = hasName ? String(req.body.display_name || "").trim() : null;
    const phoneDigits = hasPhone ? normalizePhoneDigits(req.body.phone || "") : null;
    const email = hasEmail ? String(req.body.email || "").trim().toLowerCase() : null;

    if (hasName && !displayName) {
      return jsonErr(res, 400, "MISSING_NAME", "Display name cannot be empty.");
    }
    if (hasPhone && phoneDigits && !(phoneDigits.length === 11 && phoneDigits.startsWith("1"))) {
      return jsonErr(
        res,
        400,
        "INVALID_PHONE",
        "Phone must be 10 digits (Canada/US) or include country code (e.g., 1XXXXXXXXXX)."
      );
    }

    const out = await pg.withClient(async (client) => {
      // Self-edit is always allowed (e.g., employee updating their own
      // phone number from /employee/settings). Cross-actor edits still
      // require owner/admin.
      const isSelfEdit = actorId && targetActorId === actorId;
      if (!isSelfEdit) {
        const actorRole = await getActorRole({ tenantId, actorId }, client);
        mustOwnerOrAdmin(actorRole, req.portalRole);
      }

      const cur = await client.query(
        `
        select p.display_name, p.phone_digits, p.email
          from public.chiefos_tenant_actor_profiles p
         where p.tenant_id = $1 and p.actor_id = $2
         limit 1
        `,
        [tenantId, targetActorId]
      );
      if (!cur.rowCount) {
        const err = new Error("Member not found");
        err.code = "NOT_FOUND";
        throw err;
      }
      const prev = cur.rows[0];

      const nextName = hasName ? displayName : prev.display_name;
      const nextPhone = hasPhone ? (phoneDigits || null) : prev.phone_digits;
      const nextEmail = hasEmail ? (email || null) : prev.email;

      if (!nextPhone && !nextEmail) {
        const err = new Error("Phone or email is required.");
        err.code = "MISSING_CONTACT";
        throw err;
      }

      await client.query(
        `
        update public.chiefos_tenant_actor_profiles
           set display_name = $3,
               phone_digits = $4,
               email = $5,
               updated_at = now()
         where tenant_id = $1 and actor_id = $2
        `,
        [tenantId, targetActorId, nextName, nextPhone, nextEmail]
      );

      if (hasName && nextName) {
        await client.query(
          `
          update public.chiefos_actors
             set display_name = $2, updated_at = now()
           where id = $1
          `,
          [targetActorId, nextName]
        );
      }

      // Refresh identity rows so ingestion lookups keep resolving to this actor.
      if (hasPhone) {
        if (prev.phone_digits && prev.phone_digits !== nextPhone) {
          const oldCandidates = [
            prev.phone_digits,
            "+" + prev.phone_digits,
            "whatsapp:" + prev.phone_digits,
            "whatsapp:+" + prev.phone_digits,
          ];
          await client.query(
            `
            delete from public.chiefos_actor_identities
             where actor_id = $1
               and kind = 'whatsapp'
               and identifier = any($2::text[])
            `,
            [targetActorId, oldCandidates]
          );
        }
        if (nextPhone) {
          await client.query(
            `
            insert into public.chiefos_actor_identities (kind, identifier, actor_id, created_at, updated_at)
            values
              ('whatsapp', $1, $2, now(), now()),
              ('whatsapp', '+' || $1, $2, now(), now()),
              ('whatsapp', 'whatsapp:' || $1, $2, now(), now()),
              ('whatsapp', 'whatsapp:+' || $1, $2, now(), now())
            on conflict do nothing
            `,
            [nextPhone, targetActorId]
          );
        }
      }

      if (hasEmail) {
        if (prev.email && prev.email !== nextEmail) {
          await client.query(
            `
            delete from public.chiefos_actor_identities
             where actor_id = $1 and kind = 'email' and identifier = $2
            `,
            [targetActorId, prev.email]
          );
        }
        if (nextEmail) {
          await client.query(
            `
            insert into public.chiefos_actor_identities (kind, identifier, actor_id, created_at, updated_at)
            values ('email', $1, $2, now(), now())
            on conflict do nothing
            `,
            [nextEmail, targetActorId]
          );
        }
      }

      return {
        actor_id: targetActorId,
        display_name: nextName,
        phone_digits: nextPhone,
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
      code === "MISSING_CONTACT" ? 400 :
      500;
    console.error("[CREW_ADMIN] update member error", e?.message || e);
    return jsonErr(res, status, code, e?.message || "Unable to update member.");
  }
});

/**
 * DELETE /api/crew/admin/members/:actorId
 * Owner/admin can remove a member from the tenant.
 * Safety:
 * - cannot delete owner
 * - cannot delete yourself
 */
router.delete("/admin/members/:actorId", requirePortalUser(),async (req, res) => {
  try {
    const { tenantId, actorId } = mustCtx(req);
    const targetActorId = String(req.params.actorId || "").trim();
    if (!targetActorId) return jsonErr(res, 400, "MISSING_TARGET", "Missing actorId.");

    const out = await pg.withClient(async (client) => {
      const actorRole = await getActorRole({ tenantId, actorId }, client);
      mustOwnerOrAdmin(actorRole, req.portalRole);

      if (targetActorId === actorId) {
        const err = new Error("You can’t remove yourself.");
        err.code = "SELF_DELETE_BLOCKED";
        throw err;
      }

      const t = await client.query(
        `
        select actor_id, role
        from public.chiefos_tenant_actors
        where tenant_id = $1 and actor_id = $2
        limit 1
        `,
        [tenantId, targetActorId]
      );

      if (!t?.rowCount) {
        const err = new Error("Member not found.");
        err.code = "NOT_FOUND";
        throw err;
      }

      const targetRole = String(t.rows[0].role || "");
      if (targetRole === "owner") {
        const err = new Error("Owner cannot be removed.");
        err.code = "OWNER_DELETE_BLOCKED";
        throw err;
      }

      await client.query(
        `
        update public.chiefos_board_assignments
           set active = false
         where tenant_id = $1
           and (employee_actor_id = $2 or board_actor_id = $2)
        `,
        [tenantId, targetActorId]
      );

      await client.query(
        `
        delete from public.chiefos_tenant_actor_profiles
         where tenant_id = $1
           and actor_id = $2
        `,
        [tenantId, targetActorId]
      );

      const d = await client.query(
        `
        delete from public.chiefos_tenant_actors
         where tenant_id = $1
           and actor_id = $2
         returning actor_id
        `,
        [tenantId, targetActorId]
      );

      return { actor_id: d.rows?.[0]?.actor_id || targetActorId };
    });

    return res.json({ ok: true, item: out });
  } catch (e) {
    const code = e?.code || "DELETE_MEMBER_FAILED";
    const status =
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "SELF_DELETE_BLOCKED" ? 409 :
      code === "OWNER_DELETE_BLOCKED" ? 409 :
      code === "NOT_FOUND" ? 404 :
      500;
    console.error("[CREW_ADMIN] delete member error", e?.message || e);
    return jsonErr(res, status, code, "Unable to remove member.");
  }
});

/**
 * GET /api/crew/admin/members/export.csv
 * Owner/admin exports members as CSV.
 */
router.get("/admin/members/export.csv", requirePortalUser(),async (req, res) => {
  try {
    const { tenantId, actorId } = mustCtx(req);

    const rows = await pg.withClient(async (client) => {
      const actorRole = await getActorRole({ tenantId, actorId }, client);
      mustOwnerOrAdmin(actorRole, req.portalRole);

      const r = await client.query(
        `
        select
          a.actor_id,
          a.role,
          a.created_at,
          coalesce(p.display_name, '') as display_name,
          coalesce(p.phone_digits, '') as phone_digits,
          coalesce(p.email, '') as email
        from public.chiefos_tenant_actors a
        left join public.chiefos_tenant_actor_profiles p
          on p.tenant_id = a.tenant_id and p.actor_id = a.actor_id
        where a.tenant_id = $1
        order by a.created_at asc
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

    const header = ["actor_id", "role", "display_name", "phone_digits", "email", "created_at"];
    const lines = [
      header.join(","),
      ...rows.map((r) =>
        [
          esc(r.actor_id),
          esc(r.role),
          esc(r.display_name),
          esc(r.phone_digits),
          esc(r.email),
          esc(r.created_at),
        ].join(",")
      ),
    ];

    const csv = lines.join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="crew_members_${tenantId}.csv"`);
    return res.status(200).send(csv);
  } catch (e) {
    const code = e?.code || "EXPORT_FAILED";
    const status =
      code === "PERMISSION_DENIED" ? 403 :
      500;
    console.error("[CREW_ADMIN] export error", e?.message || e);
    return jsonErr(res, status, code, "Unable to export members.");
  }
});

/**
 * POST /api/crew/admin/assign
 * Body: { employee_actor_id, board_actor_id }
 */
router.post("/admin/assign", requirePortalUser(),express.json(), async (req, res) => {
  try {
    const { tenantId, actorId } = mustCtx(req);
    const employeeActorId = String(req.body?.employee_actor_id || "").trim();
    const boardActorId = String(req.body?.board_actor_id || "").trim();

    if (!employeeActorId || !boardActorId) {
      return jsonErr(res, 400, "MISSING_FIELDS", "employee_actor_id and board_actor_id required.");
    }
    if (employeeActorId === boardActorId) {
      return jsonErr(res, 400, "INVALID_ASSIGNMENT", "Employee and reviewer cannot be the same actor.");
    }

    const out = await pg.withClient(async (client) => {
      const actorRole = await getActorRole({ tenantId, actorId }, client);
      mustOwnerOrAdmin(actorRole, req.portalRole);

      const chk = await client.query(
        `
        select actor_id, role
          from public.chiefos_tenant_actors
         where tenant_id = $1
           and actor_id in ($2, $3)
        `,
        [tenantId, employeeActorId, boardActorId]
      );

      const map = new Map(chk.rows.map((r) => [r.actor_id, r.role]));
      if (!map.has(employeeActorId) || !map.has(boardActorId)) {
        const err = new Error("Actor not found in tenant");
        err.code = "NOT_FOUND";
        throw err;
      }

      const employeeRole = map.get(employeeActorId);
      if (employeeRole !== "employee") {
        const err = new Error("Only employees can be assigned to a reviewer");
        err.code = "INVALID_EMPLOYEE";
        throw err;
      }

      const br = map.get(boardActorId);
      if (br !== "board" && br !== "owner" && br !== "admin") {
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
      code === "TENANT_CTX_MISSING" ? 403 :
      code === "PERMISSION_DENIED" ? 403 :
      code === "NOT_FOUND" ? 404 :
      code === "INVALID_REVIEWER" ? 409 :
      code === "INVALID_EMPLOYEE" ? 409 :
      500;
    console.error("[CREW_ADMIN] assign error", e?.message || e);
    return jsonErr(res, status, code, "Unable to assign employee to board.");
  }
});

/**
 * POST /api/crew/admin/invite
 * Body: { employee_name, phone?, email?, role? }
 * Owner creates an invite link and optionally sends it via SMS.
 */
router.post("/admin/invite", requirePortalUser(),express.json(), async (req, res) => {
  try {
    const { tenantId, actorId, ownerId } = mustCtx(req);

    const employeeName = String(req.body?.employee_name || "").trim();
    const rawPhone = String(req.body?.phone || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "employee").trim();
    const deliveryMethod = String(req.body?.delivery_method || "sms").trim(); // 'sms' | 'whatsapp' | 'email'

    if (!employeeName) return jsonErr(res, 400, "MISSING_NAME", "Employee name is required.");
    if (!rawPhone && !email) return jsonErr(res, 400, "MISSING_CONTACT", "Phone or email is required to send invite.");
    if (!["employee", "board"].includes(role)) return jsonErr(res, 400, "INVALID_ROLE", "Role must be employee or board.");

    const phoneDigits = normalizePhoneDigits(rawPhone);
    if (rawPhone && !(phoneDigits.length === 11 && phoneDigits.startsWith("1"))) {
      return jsonErr(res, 400, "INVALID_PHONE", "Phone must be 10 digits (Canada/US) or include country code.");
    }

    const out = await pg.withClient(async (client) => {
      const actorRole = await getActorRole({ tenantId, actorId }, client);
      mustOwnerOrAdmin(actorRole, req.portalRole);

      const r = await client.query(
        `
        INSERT INTO public.employee_invites (tenant_id, owner_id, employee_name, phone, email, role)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, token, expires_at
        `,
        [tenantId, ownerId || actorId, employeeName, phoneDigits || null, email || null, role]
      );
      return r.rows[0];
    });

    const appBase = String(process.env.APP_BASE_URL || "https://app.usechiefos.com").replace(/\/$/, "");
    const inviteUrl = `${appBase}/invite/${out.token}`;

    // Deliver invite via chosen method — always non-fatal, surface result to caller
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
        // Generate a Supabase magic link so the invitee lands authenticated
        // and the invite auto-claims — one email, one click, no retyping.
        // Falls back to the bare invite URL if generation fails; that path
        // still works via the "enter your email" form on the invite page.
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

    return res.json({ ok: true, item: { id: out.id, token: out.token, inviteUrl, expires_at: out.expires_at, deliveryMethod, deliveryOk, deliveryError } });
  } catch (e) {
    const code = e?.code || "CREATE_INVITE_FAILED";
    const status = code === "TENANT_CTX_MISSING" ? 403 : code === "PERMISSION_DENIED" ? 403 : 500;
    console.error("[CREW_INVITE] create error", e?.message || e);
    return jsonErr(res, status, code, "Unable to create invite.");
  }
});

/**
 * GET /api/crew/admin/invites
 * Owner lists pending (unclaimed) invites for their tenant.
 */
router.get("/admin/invites", requirePortalUser(),async (req, res) => {
  try {
    const { tenantId, actorId } = mustCtx(req);

    const out = await pg.withClient(async (client) => {
      const actorRole = await getActorRole({ tenantId, actorId }, client);
      mustOwnerOrAdmin(actorRole, req.portalRole);

      const r = await client.query(
        `
        SELECT id, token, employee_name, phone, email, role, expires_at, claimed_at, created_at
        FROM public.employee_invites
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT 50
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