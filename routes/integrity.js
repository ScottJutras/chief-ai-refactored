'use strict';

// routes/integrity.js
// Cryptographic record integrity API endpoints.
// Owner-only. Requires portal authentication.

const express = require('express');
const router = express.Router();
const pg = require('../services/postgres');
const integrityService = require('../services/integrity');
const { requirePortalUser } = require('../middleware/requirePortalUser');
const { plan_capabilities } = require('../src/config/planCapabilities');

// All integrity endpoints require portal auth
router.use(requirePortalUser);

/**
 * POST /api/integrity/verify
 * Run a full hash chain verification for the authenticated tenant.
 * Requires starter or pro plan.
 */
router.post('/verify', async (req, res) => {
  const { tenantId, ownerId, planKey } = req;
  const table = req.body?.table || 'transactions';

  if (!tenantId) {
    return res.status(400).json({ ok: false, error: { code: 'MISSING_TENANT', message: 'No tenant context.' } });
  }

  // Plan gate: on-demand verification requires starter or pro
  if (!planKey || planKey === 'free') {
    return res.status(402).json({
      ok: false,
      error: {
        code: 'NOT_INCLUDED',
        message: 'Record integrity verification requires a Starter or Pro plan.',
        hint: 'Upgrade to Starter to verify your financial records.',
      },
    });
  }

  if (!['transactions', 'time_entries_v2'].includes(table)) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_TABLE', message: 'Invalid table. Use transactions or time_entries_v2.' } });
  }

  try {
    const result = await integrityService.verifyTenantChain(
      pg.pool,
      tenantId,
      table,
      'on_demand'
    );

    return res.json({
      ok: true,
      chain_intact: result.chain_intact,
      total_checked: result.total_checked,
      valid: result.valid,
      invalid: result.invalid,
      unhashed: result.unhashed,
      first_invalid_id: result.first_invalid_id ?? null,
      table,
    });
  } catch (err) {
    console.error('[integrity/verify] error:', err.message);
    return res.status(500).json({
      ok: false,
      error: { code: 'VERIFICATION_FAILED', message: 'Verification encountered an error. Try again.' },
    });
  }
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
router.get('/record/:id', async (req, res) => {
  const { tenantId, planKey } = req;
  const recordId = req.params.id;

  if (!tenantId) {
    return res.status(400).json({ ok: false, error: { code: 'MISSING_TENANT', message: 'No tenant context.' } });
  }

  if (!planKey || planKey === 'free') {
    return res.status(402).json({
      ok: false,
      error: { code: 'NOT_INCLUDED', message: 'Record integrity requires a Starter or Pro plan.' },
    });
  }

  try {
    const { rows } = await pg.queryWithTimeout(
      `SELECT id, record_hash, previous_hash, hash_version, hash_input_snapshot,
              tenant_id, owner_id, user_id, kind, amount_cents, description, memo,
              job_id, source, source_msg_id, created_at
       FROM public.transactions
       WHERE id = $1 AND tenant_id = $2
       LIMIT 1`,
      [recordId, tenantId],
      4000
    );

    if (!rows?.[0]) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Record not found.' } });
    }

    const record = rows[0];
    if (!record.record_hash) {
      return res.json({ ok: true, hashed: false, record_id: recordId });
    }

    const verification = integrityService.verifyRecord(record);
    return res.json({
      ok: true,
      hashed: true,
      hash_valid: verification.hash_valid,
      content_matches_snapshot: verification.content_matches_snapshot,
      record_id: recordId,
      created_at: record.created_at,
      hash_version: record.hash_version,
    });
  } catch (err) {
    console.error('[integrity/record] error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'QUERY_FAILED', message: 'Could not fetch record.' } });
  }
});

module.exports = router;
