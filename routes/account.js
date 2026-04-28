// routes/account.js (CommonJS)
const express = require("express");
const router = express.Router();

const pg = require("../services/postgres");
const { requirePortalUser } = require("../middleware/requirePortalUser");

function jsonErr(res, status, code, message, extra) {
  return res.status(status).json({ ok: false, code, message, ...(extra || {}) });
}

async function requirePortal(req, res) {
  await new Promise((resolve, reject) =>
    requirePortalUser(req, res, (err) => (err ? reject(err) : resolve()))
  );
  return !res.headersSent;
}

/**
 * Resolve the caller's tenant_id + owner digits.
 *
 * Rebuild schema:
 * - chiefos_portal_users: user_id uuid (auth.uid()) → tenant_id uuid, role
 * - chiefos_tenants.owner_id: the canonical phone-digit owner_id for the tenant
 *
 * requirePortalUser already populates req.ownerId from tenant.owner_id; the
 * fallback path (previously via chiefos_user_identities) is redundant here.
 */
async function resolveTenantAndOwner(req) {
  const ownerDigits = String(req.ownerId || "").trim();
  const userId = String(req.userId || "").trim(); // must be set by requirePortalUser

  if (!userId) {
    throw new Error("Missing user id (portal auth).");
  }

  const mem = await pg.query(
    `
    select tenant_id
    from public.chiefos_portal_users
    where user_id = $1::uuid
    order by created_at desc
    limit 1
    `,
    [userId]
  );

  const tenantId = mem?.rows?.[0]?.tenant_id || null;
  if (!tenantId) throw new Error("No tenant membership found for this user.");

  // Fallback to chiefos_tenants.owner_id when middleware didn't populate it.
  let owner = ownerDigits;
  if (!owner) {
    const t = await pg.query(
      `select owner_id from public.chiefos_tenants where id = $1::uuid limit 1`,
      [tenantId]
    );
    owner = String(t?.rows?.[0]?.owner_id || "").trim();
  }

  if (!owner) throw new Error("No owner identifier found for this user.");

  return { tenantId, ownerId: owner, userId };
}

/**
 * RESET: Delete business data for this user's workspace.
 * Matches the deletion order you already used safely:
 * tasks -> transactions -> media_assets -> jobs
 */
router.post("/reset", async (req, res) => {
  try {
    if (!(await requirePortal(req, res))) return;

    const { tenantId, ownerId } = await resolveTenantAndOwner(req);

    // tasks (owner-only)
    await pg.query(`delete from public.tasks where owner_id = $1`, [ownerId]);

    // transactions (tenant + owner)
    await pg.query(
      `delete from public.transactions where tenant_id = $1::uuid and owner_id = $2`,
      [tenantId, ownerId]
    );

    // media assets (tenant + owner)
    await pg.query(
      `delete from public.media_assets where tenant_id = $1::uuid and owner_id = $2`,
      [tenantId, ownerId]
    );

    // jobs (owner-only)
    await pg.query(`delete from public.jobs where owner_id = $1`, [ownerId]);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.warn("[ACCOUNT reset] failed:", e?.message);
    return jsonErr(res, 500, "ERROR", e?.message || "Reset failed.");
  }
});

/**
 * DELETE: Remove all data + revoke access.
 * NOTE: Deleting the Supabase Auth user requires service role and a call to Supabase Admin API.
 * We'll do the DB cleanup here; then optionally delete Auth user if service role is present.
 */
router.post("/delete", async (req, res) => {
  try {
    if (!(await requirePortal(req, res))) return;

    const { tenantId, ownerId, userId } = await resolveTenantAndOwner(req);

    // Same wipe as reset
    await pg.query(`delete from public.tasks where owner_id = $1`, [ownerId]);
    await pg.query(
      `delete from public.transactions where tenant_id = $1::uuid and owner_id = $2`,
      [tenantId, ownerId]
    );
    await pg.query(
      `delete from public.media_assets where tenant_id = $1::uuid and owner_id = $2`,
      [tenantId, ownerId]
    );
    await pg.query(`delete from public.jobs where owner_id = $1`, [ownerId]);

    // Remove portal membership + ingestion identity for this tenant.
    // Rebuild schema: public.users is the ingestion identity (keyed by
    // phone-digit user_id = ownerId here). chiefos_user_identities no longer
    // exists in the rebuild.
    await pg.query(
      `delete from public.users where tenant_id = $1::uuid and user_id = $2`,
      [tenantId, String(ownerId)]
    );
    await pg.query(
      `delete from public.chiefos_portal_users where tenant_id = $1::uuid and user_id = $2::uuid`,
      [tenantId, userId]
    );

    // Optional: delete auth user (recommended for "delete account")
    // If you want this, tell me what your Supabase admin helper is,
    // or I’ll give you a safe drop-in using SUPABASE_SERVICE_ROLE_KEY.
    return res.status(200).json({ ok: true, deleted_auth_user: false });
  } catch (e) {
    console.warn("[ACCOUNT delete] failed:", e?.message);
    return jsonErr(res, 500, "ERROR", e?.message || "Delete failed.");
  }
});

module.exports = router;