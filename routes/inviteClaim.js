// routes/inviteClaim.js
// Public invite-claim endpoints — no portal membership required.
// GET  /api/invite/:token          — read invite details (unauthenticated)
// POST /api/invite/:token/claim    — claim invite (requires valid Supabase bearer, allowUnlinked)

const express = require("express");
const pg = require("../services/postgres");
const { requirePortalUser } = require("../middleware/requirePortalUser");

const router = express.Router();

/**
 * GET /api/invite/:token
 * Public — no auth needed. Returns invite details without exposing tenant internals.
 */
router.get("/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

  try {
    const r = await pg.query(
      `
      SELECT
        i.id,
        i.employee_name,
        i.role,
        i.expires_at,
        i.claimed_at,
        t.name AS business_name
      FROM public.employee_invites i
      LEFT JOIN public.chiefos_tenants t ON t.id = i.tenant_id
      WHERE i.token = $1
      LIMIT 1
      `,
      [token]
    );

    const invite = r.rows[0] || null;
    if (!invite) return res.status(404).json({ ok: false, error: "invite_not_found" });

    const expired = new Date(invite.expires_at) < new Date();
    const claimed = !!invite.claimed_at;

    return res.json({
      ok: true,
      invite: {
        id: invite.id,
        employee_name: invite.employee_name,
        role: invite.role,
        business_name: invite.business_name || "your team",
        expires_at: invite.expires_at,
        expired,
        claimed,
      },
    });
  } catch (e) {
    console.error("[INVITE_CLAIM] get error", e?.message || e);
    return res.status(500).json({ ok: false, error: "invite_error" });
  }
});

/**
 * POST /api/invite/:token/claim
 * Requires a valid Supabase session (allowUnlinked=true — user may not be a portal member yet).
 * Links the authenticated Supabase user to the invite's tenant as the invite's role.
 * Idempotent: claiming twice does nothing (already_claimed guard + DO NOTHING insert).
 */
router.post(
  "/:token/claim",
  requirePortalUser({ allowUnlinked: true }),
  express.json(),
  async (req, res) => {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

    const portalUserId = req.portalUserId;
    if (!portalUserId) return res.status(401).json({ ok: false, error: "not_authenticated" });

    try {
      const out = await pg.withClient(async (client) => {
        // Lock row to prevent double-claim races
        const r = await client.query(
          `
          SELECT id, tenant_id, owner_id, employee_name, role, expires_at, claimed_at
          FROM public.employee_invites
          WHERE token = $1
          LIMIT 1
          FOR UPDATE
          `,
          [token]
        );

        const invite = r.rows[0] || null;
        if (!invite) {
          const err = new Error("Invite not found");
          err.code = "NOT_FOUND";
          throw err;
        }
        if (invite.claimed_at) {
          const err = new Error("This invite has already been claimed.");
          err.code = "ALREADY_CLAIMED";
          throw err;
        }
        if (new Date(invite.expires_at) < new Date()) {
          const err = new Error("This invite has expired. Ask the owner to resend it.");
          err.code = "EXPIRED";
          throw err;
        }

        // Link user to tenant — idempotent, skip if already a member
        await client.query(
          `
          INSERT INTO public.chiefos_portal_users (user_id, tenant_id, role)
          SELECT $1, $2, $3
          WHERE NOT EXISTS (
            SELECT 1 FROM public.chiefos_portal_users
            WHERE user_id = $1 AND tenant_id = $2
          )
          `,
          [portalUserId, invite.tenant_id, invite.role]
        );

        // Mark invite claimed
        await client.query(
          `
          UPDATE public.employee_invites
          SET claimed_at = now(), claimed_by_user_id = $1
          WHERE id = $2
          `,
          [portalUserId, invite.id]
        );

        return {
          tenant_id: invite.tenant_id,
          role: invite.role,
          employee_name: invite.employee_name,
        };
      });

      return res.json({ ok: true, item: out });
    } catch (e) {
      const code = e?.code || "CLAIM_FAILED";
      const status =
        code === "NOT_FOUND" ? 404 :
        code === "ALREADY_CLAIMED" ? 409 :
        code === "EXPIRED" ? 410 :
        500;
      console.error("[INVITE_CLAIM] claim error", e?.message || e);
      return res.status(status).json({ ok: false, error: code, message: e?.message });
    }
  }
);

module.exports = router;
