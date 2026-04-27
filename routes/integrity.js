'use strict';

// routes/integrity.js
// Cryptographic record integrity API endpoints.
// Owner-only. Requires portal authentication.

const express = require('express');
const router = express.Router();
const pg = require('../services/postgres');
const integrityService = require('../services/integrity');
const { requirePortalUser, withPlanKey } = require('../middleware/requirePortalUser');
const { plan_capabilities } = require('../src/config/planCapabilities');

// All integrity endpoints require portal auth + plan resolution
router.use(requirePortalUser());
router.use(withPlanKey);

/**
 * POST /api/integrity/verify
 * Run a full hash chain verification for the authenticated tenant.
 * Requires starter or pro plan.
 */
router.post('/verify', async (_req, res) => {
  return res.status(503).json({
    error: 'verification_temporarily_unavailable',
    message: 'Integrity verification is being updated for the post-rebuild schema. The on-disk integrity chain is intact and continues to stamp new records correctly. Verification UI will return shortly.',
    issue: 'post-rebuild-v6b-jsverifier-drift',
  });
});

/**
 * GET /api/integrity/history
 * Return past verification run results.
 * Requires pro plan.
 */
router.get('/history', async (req, res) => {
  const { tenantId, planKey } = req;

  if (!tenantId) {
    return res.status(400).json({ ok: false, error: { code: 'MISSING_TENANT', message: 'No tenant context.' } });
  }

  if (planKey !== 'pro') {
    return res.status(402).json({
      ok: false,
      error: {
        code: 'NOT_INCLUDED',
        message: 'Verification history requires a Pro plan.',
        hint: 'Upgrade to Pro to access your full verification history.',
      },
    });
  }

  try {
    const history = await pg.getIntegrityVerificationHistory(tenantId, 50);
    return res.json({ ok: true, history });
  } catch (err) {
    console.error('[integrity/history] error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'QUERY_FAILED', message: 'Could not fetch history.' } });
  }
});

/**
 * GET /api/integrity/status
 * Return the latest verification status (for the portal header badge).
 * Available to starter and pro.
 */
router.get('/status', async (req, res) => {
  const { tenantId, planKey } = req;

  if (!tenantId) {
    return res.status(400).json({ ok: false, error: { code: 'MISSING_TENANT', message: 'No tenant context.' } });
  }

  if (!planKey || planKey === 'free') {
    return res.json({ ok: true, available: false });
  }

  try {
    const status = await pg.getLatestIntegrityStatus(tenantId);
    return res.json({ ok: true, available: true, status });
  } catch (err) {
    console.error('[integrity/status] error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'QUERY_FAILED', message: 'Could not fetch status.' } });
  }
});

/**
 * GET /api/integrity/record/:id
 * Return integrity details for a single transaction record.
 * Available to starter and pro.
 */
router.get('/record/:id', async (_req, res) => {
  return res.status(503).json({
    error: 'verification_temporarily_unavailable',
    message: 'Integrity verification is being updated for the post-rebuild schema. The on-disk integrity chain is intact and continues to stamp new records correctly. Verification UI will return shortly.',
    issue: 'post-rebuild-v6b-jsverifier-drift',
  });
});

module.exports = router;
