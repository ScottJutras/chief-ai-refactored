// scripts/real_lock_quote_ceremony.js
// Ceremonial first real LockQuote against the Phase A Session 3 synthetic
// tenant. Invokes handleLockQuote directly (bypassing router) to exercise
// the full 7-step sequence against production Postgres. Parallels §28's
// real_view_quote_ceremony.js posture.
//
// §17.23 state-driven idempotency: re-runs on this deterministic ceremony
// pass through the already-locked path (alreadyLockedReturnShape), NOT the
// happy-path signed→locked transition. First run is the sole happy-path
// exercise. Seed teardown + re-seed is required to re-run the happy path.
//
// §3A header-only asymmetry is the critical invariant this ceremony locks:
// the version row MUST remain status='signed' with locked_at UNCHANGED
// post-lock. Version row is DB-immutable post-sign
// (trg_chiefos_quote_versions_guard_immutable); the anomaly-stop checks
// catch any regression at handler-return time with a clear diff.
//
// Exit codes:
//   0 — ceremony succeeded (first run happy-path OR idempotent already-locked retry)
//   1 — handler returned ok:false (state-machine rejection; details in envelope)
//   2 — uncaught exception (integration gap; diagnostic in stderr)
//   3 — anomaly detected (§2 expectation drift; halt for investigation)

require('dotenv').config();
const pg = require('../services/postgres');
const { handleLockQuote } = require('../src/cil/quotes');

const {
  CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID, CEREMONY_VERSION_ID,
} = require('./_phase_a_session3_constants');

const CEREMONY_SOURCE_MSG_ID = 'ceremony-phase-a-s3-lockquote-run-1';

async function captureState(label) {
  const r = await pg.query(
    `SELECT q.status AS q_status, q.updated_at AS q_updated_at,
            v.status AS v_status, v.locked_at AS v_locked_at,
            v.signed_at AS v_signed_at, v.server_hash AS v_server_hash
       FROM public.chiefos_quotes q
       JOIN public.chiefos_quote_versions v ON v.id = q.current_version_id
      WHERE q.id = $1`,
    [CEREMONY_QUOTE_ID]
  );
  const row = r.rows[0];
  console.log(`[${label}] quote.status=${row.q_status}, quote.updated_at=${row.q_updated_at?.toISOString()}`);
  console.log(`[${label}] version.status=${row.v_status}, version.locked_at=${row.v_locked_at?.toISOString() ?? 'null'}`);
  return row;
}

(async () => {
  try {
    console.log('─── Phase A Session 3 ceremony — LockQuote against production ─');
    console.log(`tenant_id:      ${CEREMONY_TENANT_ID}`);
    console.log(`owner_id:       ${CEREMONY_OWNER_ID}`);
    console.log(`quote_id:       ${CEREMONY_QUOTE_ID}`);
    console.log(`version_id:     ${CEREMONY_VERSION_ID}`);
    console.log(`source_msg_id:  ${CEREMONY_SOURCE_MSG_ID}`);
    console.log('');

    // ─── Pre-ceremony state capture ────────────────────────────────────────
    console.log('─── Pre-ceremony state ─────────────────────────────────────');
    const before = await captureState('PRE');
    console.log('');

    // ─── Invoke handleLockQuote ────────────────────────────────────────────
    const cil = {
      cil_version: '1.0',
      type: 'LockQuote',
      tenant_id: CEREMONY_TENANT_ID,
      source: 'system',
      source_msg_id: CEREMONY_SOURCE_MSG_ID,
      actor: {
        role: 'system',
        actor_id: 'system:phase-a-session-3-ceremony',
      },
      occurred_at: new Date().toISOString(),
      job: null,
      needs_job_resolution: false,
      quote_ref: { quote_id: CEREMONY_QUOTE_ID },
    };

    const ctx = {
      owner_id: CEREMONY_OWNER_ID,
      traceId: `ceremony-lock-phase-a-s3-${Date.now()}`,
    };

    console.log('[CEREMONY] invoking handleLockQuote...');
    const result = await handleLockQuote(cil, ctx);
    console.log('');
    console.log('─── handleLockQuote result ─────────────────────────────────');
    console.log(JSON.stringify(result, null, 2));
    console.log('');

    if (!result.ok) {
      console.error('[CEREMONY] ✗ handler returned ok:false');
      console.error(`  code:    ${result.error.code}`);
      console.error(`  message: ${result.error.message}`);
      console.error(`  hint:    ${result.error.hint}`);
      process.exit(1);
    }

    // ─── Post-ceremony state capture ───────────────────────────────────────
    console.log('─── Post-ceremony state ────────────────────────────────────');
    const after = await captureState('POST');
    console.log('');

    // ─── Event readback ────────────────────────────────────────────────────
    console.log('─── Events chain for ceremony quote (ordered by global_seq) ─');
    const events = await pg.query(
      `SELECT global_seq, id, kind, correlation_id, emitted_at, payload
         FROM public.chiefos_quote_events
        WHERE quote_id = $1
        ORDER BY global_seq ASC`,
      [CEREMONY_QUOTE_ID]
    );
    for (const ev of events.rows) {
      console.log(`  seq=${ev.global_seq}  kind=${ev.kind.padEnd(28)}  correlation_id=${ev.correlation_id ?? 'NULL'}  emitted_at=${ev.emitted_at.toISOString()}`);
    }
    console.log('');

    // ─── Anomaly-stop checks ───────────────────────────────────────────────
    console.log('─── Anomaly-stop validation ────────────────────────────────');
    const anomalies = [];

    // Detect run mode: happy path (pre.q_status='signed') vs. already-locked
    const happyPath = before.q_status === 'signed';
    console.log(`run mode: ${happyPath ? 'HAPPY PATH (first run)' : 'ALREADY-LOCKED (idempotent retry)'}`);

    if (happyPath) {
      // ── Happy-path expectations ─────────────────────────────────────────
      if (result.meta.events_emitted.length !== 1 || result.meta.events_emitted[0] !== 'lifecycle.locked') {
        anomalies.push(`events_emitted unexpected: ${JSON.stringify(result.meta.events_emitted)} (expected ['lifecycle.locked'])`);
      }
      if (result.meta.already_existed !== false) {
        anomalies.push(`meta.already_existed=${result.meta.already_existed} (expected false on happy path)`);
      }
      if (!result.meta.correlation_id || !/^[0-9a-f-]{36}$/.test(result.meta.correlation_id)) {
        anomalies.push(`meta.correlation_id invalid/null: ${result.meta.correlation_id}`);
      }
      if (result.quote.status !== 'locked') {
        anomalies.push(`result.quote.status=${result.quote.status} (expected 'locked')`);
      }
      // CRITICAL §3A: version.status must stay 'signed' post-lock
      if (result.version.status !== 'signed') {
        anomalies.push(`result.version.status=${result.version.status} (expected 'signed' per §3A header-only asymmetry — version row is post-sign immutable)`);
      }

      // Find the emitted event row and validate correlation_id parity
      const lockedEvents = events.rows.filter((e) => e.kind === 'lifecycle.locked');
      if (lockedEvents.length !== 1) {
        anomalies.push(`lifecycle.locked event count=${lockedEvents.length} (expected 1 — single event emitted per LockQuote invocation)`);
      } else {
        const lockedEv = lockedEvents[0];
        if (lockedEv.correlation_id !== result.meta.correlation_id) {
          anomalies.push(
            `correlation_id mismatch: meta=${result.meta.correlation_id}, event=${lockedEv.correlation_id}`
          );
        }
        // source_msg_id payload echo (§17.25 echo-if-present)
        if (!lockedEv.payload || lockedEv.payload.source_msg_id !== CEREMONY_SOURCE_MSG_ID) {
          anomalies.push(
            `source_msg_id payload echo missing: payload=${JSON.stringify(lockedEv.payload)}`
          );
        }
      }

      // CRITICAL §3A DB-side: version row UNCHANGED post-lock.
      // locked_at from PRE must equal locked_at from POST (not bumped);
      // server_hash unchanged; status stays 'signed'.
      if (before.v_locked_at && after.v_locked_at &&
          before.v_locked_at.getTime() !== after.v_locked_at.getTime()) {
        anomalies.push(
          `version.locked_at MUTATED post-lock: pre=${before.v_locked_at.toISOString()} vs post=${after.v_locked_at.toISOString()} (§3A violation — version is post-sign immutable)`
        );
      }
      if (before.v_server_hash !== after.v_server_hash) {
        anomalies.push(
          `version.server_hash MUTATED post-lock: pre=${before.v_server_hash} vs post=${after.v_server_hash} (§3A violation)`
        );
      }
      if (after.v_status !== 'signed') {
        anomalies.push(
          `version.status drift post-lock: expected 'signed' (§3A), got '${after.v_status}'`
        );
      }

      // State-transition completeness — header flipped
      if (after.q_status !== 'locked') {
        anomalies.push(
          `post-state drift: quote.status=${after.q_status} (expected 'locked')`
        );
      }

      // Timestamp relationship: quote.updated_at (fresh txn NOW()) must be
      // strictly AFTER version.locked_at (seed set it to NOW()-60s; handler
      // runs NOW() — fresh > seed-minus-60s).
      if (after.q_updated_at && after.v_locked_at &&
          after.q_updated_at.getTime() <= after.v_locked_at.getTime()) {
        anomalies.push(
          `timestamp ordering violation: quote.updated_at=${after.q_updated_at.toISOString()} NOT strictly after version.locked_at=${after.v_locked_at.toISOString()}`
        );
      }
    } else {
      // ── Already-locked retry expectations ───────────────────────────────
      if (result.meta.events_emitted.length !== 0) {
        anomalies.push(`events_emitted should be [] on retry, got ${JSON.stringify(result.meta.events_emitted)}`);
      }
      if (result.meta.already_existed !== true) {
        anomalies.push(`meta.already_existed=${result.meta.already_existed} (expected true on retry)`);
      }
      if (result.meta.correlation_id !== null) {
        anomalies.push(`meta.correlation_id=${result.meta.correlation_id} (expected null on retry)`);
      }
      if (result.quote.status !== 'locked') {
        anomalies.push(`result.quote.status=${result.quote.status} (expected 'locked' on retry)`);
      }
      if (result.version.status !== 'signed') {
        anomalies.push(`result.version.status=${result.version.status} (expected 'signed' per §3A on retry)`);
      }
    }

    if (anomalies.length > 0) {
      console.error('[CEREMONY] ✗ ANOMALIES DETECTED — halting before §30 documentation:');
      for (const a of anomalies) console.error(`  - ${a}`);
      process.exit(3);
    }
    console.log('[CEREMONY] ✓ all anomaly-stop checks passed');
    console.log('');

    // ─── Captured §30 artifact values ──────────────────────────────────────
    console.log('─── Captured §30 artifact values ──────────────────────────');
    console.log(`correlation_id:        ${result.meta.correlation_id ?? 'NULL (retry path)'}`);
    console.log(`events_emitted:        ${JSON.stringify(result.meta.events_emitted)}`);
    console.log(`already_existed:       ${result.meta.already_existed}`);
    console.log(`quote.status:          ${result.quote.status}`);
    console.log(`quote.updated_at:      ${result.quote.updated_at}`);
    console.log(`version.status:        ${result.version.status}  (§3A — unchanged)`);
    console.log(`version.locked_at:     ${result.version.locked_at}  (§3A — unchanged from sign-time)`);
    console.log(`version.server_hash:   ${result.version.server_hash}  (§3A — unchanged)`);
    console.log('');
    console.log('Events captured above. Use these values to populate §30.');
    process.exit(0);
  } catch (err) {
    console.error('[CEREMONY] ✗ uncaught exception during handler invocation:');
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  }
})();
