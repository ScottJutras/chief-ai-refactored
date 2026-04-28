// scripts/real_view_quote_ceremony.js
// Ceremonial first real ViewQuote against the Phase A Session 2 synthetic
// tenant. Invokes handleViewQuote directly (bypassing router) to exercise
// the full 7-step sequence against production Postgres. Parallels §27's
// real_sign_quote_ceremony.js posture.
//
// §17.23 state-driven idempotency: re-runs on this deterministic ceremony
// pass through the already-viewed path (alreadyViewedReturnShape), NOT the
// happy-path sent→viewed transition. First run is the sole happy-path
// exercise. Seed teardown + re-seed is required to re-run the happy path.
//
// Exit codes:
//   0 — ceremony succeeded (first run happy-path OR idempotent already-viewed retry)
//   1 — handler returned ok:false (state-machine rejection; details in envelope)
//   2 — uncaught exception (integration gap; diagnostic in stderr)
//   3 — anomaly detected (Section 4 expectation drift; halt for investigation)

require('dotenv').config();
const pg = require('../services/postgres');
const { handleViewQuote } = require('../src/cil/quotes');

const {
  CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID, CEREMONY_VERSION_ID,
  CEREMONY_SHARE_TOKEN_ID, CEREMONY_SHARE_TOKEN,
} = require('./_phase_a_session2_constants');

const CEREMONY_SOURCE_MSG_ID = 'ceremony-phase-a-s2-viewquote-run-1';

async function captureState(label) {
  const r = await pg.query(
    `SELECT q.status AS q_status, q.updated_at AS q_updated_at,
            v.status AS v_status, v.viewed_at AS v_viewed_at,
            v.sent_at AS v_sent_at
       FROM public.chiefos_quotes q
       JOIN public.chiefos_quote_versions v ON v.id = q.current_version_id
      WHERE q.id = $1`,
    [CEREMONY_QUOTE_ID]
  );
  const row = r.rows[0];
  console.log(`[${label}] quote.status=${row.q_status}, quote.updated_at=${row.q_updated_at?.toISOString()}`);
  console.log(`[${label}] version.status=${row.v_status}, version.viewed_at=${row.v_viewed_at?.toISOString() ?? 'null'}`);
  return row;
}

(async () => {
  try {
    console.log('─── Phase A Session 2 ceremony — ViewQuote against production ─');
    console.log(`tenant_id:      ${CEREMONY_TENANT_ID}`);
    console.log(`owner_id:       ${CEREMONY_OWNER_ID}`);
    console.log(`quote_id:       ${CEREMONY_QUOTE_ID}`);
    console.log(`version_id:     ${CEREMONY_VERSION_ID}`);
    console.log(`share_token:    ${CEREMONY_SHARE_TOKEN}`);
    console.log(`source_msg_id:  ${CEREMONY_SOURCE_MSG_ID}`);
    console.log('');

    // ─── Pre-ceremony state capture ────────────────────────────────────
    console.log('─── Pre-ceremony state ─────────────────────────────────────');
    const before = await captureState('PRE');
    console.log('');

    // ─── Invoke handleViewQuote ────────────────────────────────────────
    const cil = {
      cil_version: '1.0',
      type: 'ViewQuote',
      tenant_id: CEREMONY_TENANT_ID,
      source: 'web',
      source_msg_id: CEREMONY_SOURCE_MSG_ID,
      actor: {
        role: 'customer',
        actor_id: CEREMONY_SHARE_TOKEN_ID,  // §14.11 share_token_id as actor_id
      },
      occurred_at: new Date().toISOString(),
      job: null,
      needs_job_resolution: false,
      share_token: CEREMONY_SHARE_TOKEN,
    };

    const ctx = {
      owner_id: CEREMONY_OWNER_ID,
      traceId: `ceremony-view-phase-a-s2-${Date.now()}`,
    };

    console.log('[CEREMONY] invoking handleViewQuote...');
    const result = await handleViewQuote(cil, ctx);
    console.log('');
    console.log('─── handleViewQuote result ─────────────────────────────────');
    console.log(JSON.stringify(result, null, 2));
    console.log('');

    if (!result.ok) {
      console.error('[CEREMONY] ✗ handler returned ok:false');
      console.error(`  code:    ${result.error.code}`);
      console.error(`  message: ${result.error.message}`);
      console.error(`  hint:    ${result.error.hint}`);
      process.exit(1);
    }

    // ─── Post-ceremony state capture ───────────────────────────────────
    console.log('─── Post-ceremony state ────────────────────────────────────');
    const after = await captureState('POST');
    console.log('');

    // ─── Event readback ────────────────────────────────────────────────
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

    // ─── Anomaly-stop checks (per user directive) ──────────────────────
    console.log('─── Anomaly-stop validation ────────────────────────────────');
    const anomalies = [];

    // Detect run mode: happy path (pre.q_status='sent') vs. already-viewed
    const happyPath = before.q_status === 'sent';
    console.log(`run mode: ${happyPath ? 'HAPPY PATH (first run)' : 'ALREADY-VIEWED (idempotent retry)'}`);

    if (happyPath) {
      // Expectation set for happy-path first run
      if (result.meta.events_emitted.length !== 1 || result.meta.events_emitted[0] !== 'lifecycle.customer_viewed') {
        anomalies.push(`events_emitted unexpected: ${JSON.stringify(result.meta.events_emitted)} (expected ['lifecycle.customer_viewed'])`);
      }
      if (result.meta.already_existed !== false) {
        anomalies.push(`meta.already_existed=${result.meta.already_existed} (expected false on happy path)`);
      }
      if (!result.meta.correlation_id || !/^[0-9a-f-]{36}$/.test(result.meta.correlation_id)) {
        anomalies.push(`meta.correlation_id invalid/null: ${result.meta.correlation_id}`);
      }
      if (result.quote.status !== 'viewed') {
        anomalies.push(`result.quote.status=${result.quote.status} (expected 'viewed')`);
      }
      if (result.version.status !== 'viewed') {
        anomalies.push(`result.version.status=${result.version.status} (expected 'viewed')`);
      }

      // Find the emitted event row and validate correlation_id parity
      const cvEvents = events.rows.filter((e) => e.kind === 'lifecycle.customer_viewed');
      if (cvEvents.length !== 1) {
        anomalies.push(`lifecycle.customer_viewed event count=${cvEvents.length} (expected 1)`);
      } else {
        const cvEv = cvEvents[0];
        if (cvEv.correlation_id !== result.meta.correlation_id) {
          anomalies.push(
            `correlation_id mismatch: meta=${result.meta.correlation_id}, event=${cvEv.correlation_id}`
          );
        }
        // source_msg_id payload echo (posture B / §17.25 first exerciser)
        if (!cvEv.payload || cvEv.payload.source_msg_id !== CEREMONY_SOURCE_MSG_ID) {
          anomalies.push(
            `source_msg_id payload echo missing: payload=${JSON.stringify(cvEv.payload)}`
          );
        }
      }

      // Timestamp coherence: quote.updated_at should equal version.viewed_at
      // (both NOW() inside a single transaction per §17.24 header-first)
      if (after.q_updated_at && after.v_viewed_at &&
          after.q_updated_at.getTime() !== after.v_viewed_at.getTime()) {
        anomalies.push(
          `timestamp drift: quote.updated_at=${after.q_updated_at.toISOString()} vs version.viewed_at=${after.v_viewed_at.toISOString()}`
        );
      }

      // State-transition completeness
      if (after.q_status !== 'viewed' || after.v_status !== 'viewed') {
        anomalies.push(
          `post-state drift: quote.status=${after.q_status} version.status=${after.v_status} (expected viewed/viewed)`
        );
      }
    } else {
      // Already-viewed retry expectations
      if (result.meta.events_emitted.length !== 0) {
        anomalies.push(`events_emitted should be [] on retry, got ${JSON.stringify(result.meta.events_emitted)}`);
      }
      if (result.meta.already_existed !== true) {
        anomalies.push(`meta.already_existed=${result.meta.already_existed} (expected true on retry)`);
      }
      if (result.meta.correlation_id !== null) {
        anomalies.push(`meta.correlation_id=${result.meta.correlation_id} (expected null on retry)`);
      }
    }

    if (anomalies.length > 0) {
      console.error('[CEREMONY] ✗ ANOMALIES DETECTED — halting before §28 documentation:');
      for (const a of anomalies) console.error(`  - ${a}`);
      process.exit(3);
    }
    console.log('[CEREMONY] ✓ all anomaly-stop checks passed');
    console.log('');

    // ─── Captured §28 artifact values ──────────────────────────────────
    console.log('─── Captured §28 artifact values ──────────────────────────');
    console.log(`correlation_id:        ${result.meta.correlation_id ?? 'NULL (retry path)'}`);
    console.log(`events_emitted:        ${JSON.stringify(result.meta.events_emitted)}`);
    console.log(`already_existed:       ${result.meta.already_existed}`);
    console.log(`quote.status:          ${result.quote.status}`);
    console.log(`quote.updated_at:      ${result.quote.updated_at}`);
    console.log(`version.status:        ${result.version.status}`);
    console.log(`version.viewed_at:     ${result.version.viewed_at}`);
    console.log(`share_token.token:     ${result.share_token.token}`);
    console.log('');
    console.log('Events captured above. Use these values to populate §28.');
    process.exit(0);
  } catch (err) {
    console.error('[CEREMONY] ✗ uncaught exception during handler invocation:');
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  }
})();
