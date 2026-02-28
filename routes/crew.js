// routes/crew.js
const express = require("express");
const pg = require("../services/postgres");

// Portal auth gate (must exist in your repo)
const { requirePortalUser } = require("../middleware/requirePortalUser");
const router = express.Router();

/**
 * Pull tenant+actor context from portal auth middleware.
 * Fail closed: if anything is missing, return 403.
 */
async function getCrewCtx(req) {
  const tenantId = req.tenantId || null;
  const ownerId = req.ownerId || null;
  const role = String(req.portalRole || "").toLowerCase() || null;

  let actorId =
    req.actorId ||
    req.actor_id ||
    null;

  // ✅ If portal auth didn't provide actorId, fallback for owner/admin:
  // pick the tenant owner/admin actor
  if (!actorId && tenantId && (role === "owner" || role === "admin")) {
    const r = await pg.query(
      `
      select actor_id
      from public.chiefos_tenant_actors
      where tenant_id = $1
        and role in ('owner','admin')
      order by case role when 'owner' then 0 else 1 end
      limit 1
      `,
      [tenantId]
    );
    actorId = r?.rows?.[0]?.actor_id || null;
  }

  return { tenantId, actorId, ownerId, role };
}

/**
 * GET /api/crew/inbox
 * Returns crew activity logs that are awaiting this reviewer's action.
 */
router.get("/inbox", requirePortalUser, async (req, res) => {
  try {
    const { tenantId, actorId } = await getCrewCtx(req);

    if (!tenantId || !actorId) {
      return res.status(403).json({
        ok: false,
        code: "CREW_CTX_MISSING",
        message: "Missing tenant/actor context. Ensure portal auth sets tenant_id and actor_id.",
      });
    }

    // Filters
    const status = String(req.query.status || "submitted").trim().toLowerCase();
    const type = req.query.type ? String(req.query.type).trim().toLowerCase() : null;
    // Allow-list filters (fail closed)
const ALLOWED_STATUS = new Set(["submitted", "needs_clarification", "approved", "rejected", "draft"]);
const ALLOWED_TYPE = new Set(["task", "time"]);

if (!ALLOWED_STATUS.has(status)) {
  return res.status(400).json({ ok: false, code: "BAD_STATUS", message: "Invalid status." });
}
if (type && !ALLOWED_TYPE.has(type)) {
  return res.status(400).json({ ok: false, code: "BAD_TYPE", message: "Invalid type." });
}
    const limitRaw = parseInt(String(req.query.limit || "50"), 10);
    const offsetRaw = parseInt(String(req.query.offset || "0"), 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

    // NOTE:
    // - reviewer_actor_id is the routing field
    // - we return creator name if available
    const params = [tenantId, actorId, status, limit, offset];
    let sql = `
      select
        l.id,
        l.tenant_id,
        l.owner_id,
        l.created_by_actor_id,
        ca.display_name as created_by_name,
        l.reviewer_actor_id,
        ra.display_name as reviewer_name,
        l.type,
        l.source,
        l.content_text,
        l.structured,
        l.media_asset_id,
        l.status,
        l.reviewed_by_actor_id,
        l.reviewed_at,
        l.edit_of_log_id,
        l.source_msg_id,
        l.created_at,
        l.updated_at
      from public.chiefos_activity_logs l
      left join public.chiefos_actors ca on ca.id = l.created_by_actor_id
      left join public.chiefos_actors ra on ra.id = l.reviewer_actor_id
      where l.tenant_id = $1
        and l.reviewer_actor_id = $2
        and l.status = $3
    `;

    if (type) {
      params.splice(3, 0, type); // insert type at index 3
      sql += ` and l.type = $4 `;
      // shift limit/offset placeholders by +1
      sql += ` order by l.created_at desc limit $5 offset $6 `;
    } else {
      sql += ` order by l.created_at desc limit $4 offset $5 `;
    }

    const { rows } = await pg.query(sql, params);

    return res.json({
      ok: true,
      count: rows?.length || 0,
      items: rows || [],
      next: {
        limit,
        offset: offset + (rows?.length || 0),
      },
    });
  } catch (e) {
    console.warn("[CREW_INBOX] failed:", e?.message);
    return res.status(500).json({ ok: false, code: "CREW_INBOX_FAILED", message: e?.message || "failed" });
  }
});

module.exports = router;