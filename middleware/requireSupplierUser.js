// middleware/requireSupplierUser.js
// Auth middleware for the supplier self-service portal.
// Mirrors requirePortalUser but resolves supplier_id instead of tenant_id.

'use strict';

const { createClient } = require('@supabase/supabase-js');
const pg = require('../services/postgres');

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function parseBearer(req) {
  const raw = req.get('authorization') || req.get('Authorization') || '';
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^bearer\s+(.+)$/i);
  return (m ? m[1] : s).trim() || null;
}

function supabaseAdmin() {
  const url = mustEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = mustEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

/**
 * requireSupplierUser()
 *
 * Verifies the request comes from a valid supplier portal user.
 * Sets on req:
 *   req.supplierAuthUid   — Supabase auth UUID
 *   req.supplierUserId    — supplier_users.id (portal user row UUID)
 *   req.supplierId        — suppliers.id (the supplier org UUID)
 *   req.supplierRole      — 'owner' | 'admin' | 'editor'
 *   req.supplier          — full suppliers row
 *   req.supplierUser      — full supplier_users row
 *
 * Returns 401 if no/invalid token.
 * Returns 403 if user is not a supplier portal user or supplier is inactive.
 */
function requireSupplierUser() {
  return async function supplierAuthMiddleware(req, res, next) {
    try {
      const token = parseBearer(req);
      if (!token) {
        return res.status(401).json({ ok: false, error: 'missing_bearer' });
      }

      const sb = supabaseAdmin();

      // 1) Verify Supabase session
      const userRes = await sb.auth.getUser(token);
      const user = userRes?.data?.user || null;
      if (!user?.id) {
        return res.status(401).json({ ok: false, error: 'invalid_session' });
      }

      // 2) Look up supplier_users row
      const { rows: suRows } = await pg.query(
        `SELECT su.id, su.supplier_id, su.email, su.full_name, su.role, su.is_active
         FROM public.supplier_users su
         WHERE su.auth_uid = $1 AND su.is_active = true
         LIMIT 1`,
        [user.id]
      );

      const supplierUser = suRows?.[0] || null;
      if (!supplierUser) {
        return res.status(403).json({ ok: false, error: 'not_a_supplier_user' });
      }

      // 3) Load the supplier org
      const { rows: sRows } = await pg.query(
        `SELECT id, slug, name, status, region, supplier_type, onboarding_completed,
                primary_contact_name, primary_contact_email, company_phone, company_address,
                website_url, description, catalog_update_cadence, created_at, updated_at
         FROM public.suppliers
         WHERE id = $1
         LIMIT 1`,
        [supplierUser.supplier_id]
      );

      const supplier = sRows?.[0] || null;
      if (!supplier) {
        return res.status(403).json({ ok: false, error: 'supplier_not_found' });
      }

      // Update last_login_at (fire-and-forget)
      pg.query(
        `UPDATE public.supplier_users SET last_login_at = now() WHERE id = $1`,
        [supplierUser.id]
      ).catch(() => {});

      req.supplierAuthUid = user.id;
      req.supplierUserId  = supplierUser.id;
      req.supplierId      = supplier.id;
      req.supplierRole    = supplierUser.role;
      req.supplier        = supplier;
      req.supplierUser    = supplierUser;

      return next();
    } catch (e) {
      console.error('[SUPPLIER_AUTH_ERR]', e?.message || e);
      return res.status(500).json({ ok: false, error: 'supplier_auth_error' });
    }
  };
}

/**
 * requireSupplierRole(roles)
 * Call after requireSupplierUser(). Blocks if user's role is not in the allowed set.
 * Usage: router.delete('/products/:id', requireSupplierRole(['owner','admin']), handler)
 */
function requireSupplierRole(roles = []) {
  return function (req, res, next) {
    if (!roles.includes(req.supplierRole)) {
      return res.status(403).json({
        ok: false,
        error: 'insufficient_role',
        message: `This action requires one of: ${roles.join(', ')}.`,
      });
    }
    return next();
  };
}

module.exports = { requireSupplierUser, requireSupplierRole };
