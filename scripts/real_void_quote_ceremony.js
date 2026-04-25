// scripts/real_void_quote_ceremony.js
// Ceremonial first real VoidQuote against the Phase A Session 4 synthetic
// tenant. Invokes handleVoidQuote directly (bypassing router) to exercise
// the full Step 0-7 sequence against production Postgres. Parallels §28's
// real_view_quote_ceremony.js and §30's real_lock_quote_ceremony.js posture.
//
// §17.23 state-driven idempotency: re-runs on this deterministic ceremony
// pass through the already-voided path (alreadyVoidedReturnShape — Step 5
// pre-txn routing), NOT the happy-path sent→voided transition. First run
// is the sole happy-path exercise. Seed teardown + re-seed is required to
// re-run the happy path.
//
// §3A header-only asymmetry is the critical invariant this ceremony locks:
// the version row MUST remain status='sent' with all timestamps and
// server_hash UNCHANGED post-void. The version row's status enum at
// Migration 1 line 121 excludes 'voided' — version is constitutionally a
// pass-through across the void transition. Anomaly-stop checks catch any
// regression at handler-return time AND DB-side post-state read.
//
// Payload CHECK obligation (chiefos_qe_payload_voided at Migration 2 line
// 190-191): payload ? 'voided_reason' must be true when
// kind='lifecycle.voided'. The handler's emitLifecycleVoided assembles
// payload from data.voided_reason (VoidQuoteCILZ z.string().min(1)).
// Anomaly-stop check #6 confirms the CHECK is satisfied in production.
//
// Exit codes:
//   0 — ceremony succeeded (first run happy-path OR idempotent already-voided retry)
//   1 — handler returned ok:false (state-machine rejection; details in envelope)
//   2 — uncaught exception (integration gap; diagnostic in stderr)
//   3 — anomaly detected (§2 expectation drift; halt for investigation)

require('dotenv').config();
const pg = require('../services/postgres');
const { handleVoidQuote } = require('../src/cil/quotes');

const {
  CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID, CEREMONY_VERSION_ID,
} = require('./_phase_a_session4_constants');

const CEREMONY_SOURCE_MSG_ID = 'ceremony-phase-a-s4-voidquote-run-1';
const CEREMONY_VOIDED_REASON = 'Phase A Session 4 ceremony — representative system-initiated void from sent state';

async function captureState(label) {
  const r = await pg.query(
    `SELECT q.status        AS q_status,
            q.updated_at    AS q_updated_at,
            q.voided_at     AS q_voided_at,
            q.voided_reason AS q_voided_reason,
            v.status        AS v_status,
            v.locked_at     AS v_locked_at,
            v.signed_at     AS v_signed_at,
            v.viewed_at     AS v_viewed_at,
            v.sent_at       AS v_sent_at,
            v.server_hash   AS v_server_hash
       FROM public.chiefos_quotes q
       JOIN public.chiefos_quote_versions v ON v.id = q.current_version_id
      WHERE q.id = $1`,
    [CEREMONY_QUOTE_ID]
  );
  const row = r.rows[0];
  console.log(`[${label}] quote.status=${row.q_status}, quote.updated_at=${row.q_updated_at?.toISOString()}`);
  console.log(`[${label}] quote.voided_at=${row.q_voided_at?.toISOString() ?? 'null'}, voided_reason=${row.q_voided_reason ?? 'null'}`);
  console.log(`[${label}] version.status=${row.v_status}, sent_at=${row.v_sent_at?.toISOString()}, locked_at=${row.v_locked_at?.toISOString() ?? 'null'}`);
  return row;
}

(async () => {
  try {
    console.log('─── Phase A Session 4 ceremony — VoidQuote against production ─');
    console.log(`tenant_id:      ${CEREMONY_TENANT_ID}`);
    console.log(`owner_id:       ${CEREMONY_OWNER_ID}`);
    console.log(`quote_id:       ${CEREMONY_QUOTE_ID}`);
    console.log(`version_id:     ${CEREMONY_VERSION_ID}`);
    console.log(`source_msg_id:  ${CEREMONY_SOURCE_MSG_ID}`);
    console.log(`voided_reason:  ${CEREMONY_VOIDED_REASON}`);
    console.log('');

    // ─── Pre-ceremony state capture ────────────────────────────────────────
    console.log('─── Pre-ceremony state ─────────────────────────────────────');
    const before = await captureState('PRE');
    console.log('');

    // ─── Invoke handleVoidQuote ────────────────────────────────────────────
    const cil = {
      cil_version: '1.0',
      type: 'VoidQuote',
      tenant_id: CEREMONY_TENANT_ID,
      source: 'system',
      source_msg_id: CEREMONY_SOURCE_MSG_ID,
      actor: {
        role: 'system',
        actor_id: 'system:phase-a-session-4-ceremony',
      },
      occurred_at: new Date().toISOString(),
      job: null,
      needs_job_resolution: false,
      quote_ref: { quote_id: CEREMONY_QUOTE_ID },
      voided_reason: CEREMONY_VOIDED_REASON,
    };

    const ctx = {
      owner_id: CEREMONY_OWNER_ID,
      traceId: `ceremony-void-phase-a-s4-${Date.now()}`,
    };

    console.log('[CEREMONY] invoking handleVoidQuote...');
    const result = await handleVoidQuote(cil, ctx);
    console.log('');
    console.log('─── handleVoidQuote result ─────────────────────────────────');
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

    // Detect run mode: happy path (pre.q_status='sent') vs. already-voided
    const happyPath = before.q_status !== 'voided';
    console.log(`run mode: ${happyPath ? `HAPPY PATH (first run from '${before.q_status}')` : 'ALREADY-VOIDED (idempotent retry)'}`);

    if (happyPath) {
      // ── Happy-path expectations ─────────────────────────────────────────
      // 1. events_emitted exactly ['lifecycle.voided']
      if (result.meta.events_emitted.length !== 1 || result.meta.events_emitted[0] !== 'lifecycle.voided') {
        anomalies.push(`events_emitted unexpected: ${JSON.stringify(result.meta.events_emitted)} (expected ['lifecycle.voided'])`);
      }
      // 2. meta.already_existed = false
      if (result.meta.already_existed !== false) {
        anomalies.push(`meta.already_existed=${result.meta.already_existed} (expected false on happy path)`);
      }
      // 3. meta.correlation_id non-null UUID
      if (!result.meta.correlation_id || !/^[0-9a-f-]{36}$/.test(result.meta.correlation_id)) {
        anomalies.push(`meta.correlation_id invalid/null: ${result.meta.correlation_id}`);
      }
      // 4. result.quote.status='voided'
      if (result.quote.status !== 'voided') {
        anomalies.push(`result.quote.status=${result.quote.status} (expected 'voided')`);
      }
      // 5. result.quote.voided_reason matches CIL input
      if (result.quote.voided_reason !== CEREMONY_VOIDED_REASON) {
        anomalies.push(`result.quote.voided_reason=${result.quote.voided_reason} (expected exact match to CIL input)`);
      }
      // 6. result.quote.voided_at populated (truthy)
      if (!result.quote.voided_at) {
        anomalies.push(`result.quote.voided_at falsy: ${result.quote.voided_at} (expected timestamp)`);
      }
      // 7. CRITICAL §3A: result.version.status pass-through (NOT 'voided')
      if (result.version.status !== before.v_status) {
        anomalies.push(`result.version.status=${result.version.status} (expected pass-through '${before.v_status}' per §3A)`);
      }

      // Find the emitted event row and validate
      const voidedEvents = events.rows.filter((e) => e.kind === 'lifecycle.voided');
      if (voidedEvents.length !== 1) {
        anomalies.push(`lifecycle.voided event count=${voidedEvents.length} (expected 1)`);
      } else {
        const voidedEv = voidedEvents[0];
        // 8. correlation_id parity meta ↔ event row
        if (voidedEv.correlation_id !== result.meta.correlation_id) {
          anomalies.push(
            `correlation_id mismatch: meta=${result.meta.correlation_id}, event=${voidedEv.correlation_id}`
          );
        }
        // 9. CHECK obligation: payload.voided_reason populated
        if (!voidedEv.payload || typeof voidedEv.payload.voided_reason !== 'string' || voidedEv.payload.voided_reason.length === 0) {
          anomalies.push(
            `chiefos_qe_payload_voided CHECK obligation unmet: payload=${JSON.stringify(voidedEv.payload)}`
          );
        } else if (voidedEv.payload.voided_reason !== CEREMONY_VOIDED_REASON) {
          anomalies.push(
            `payload.voided_reason mismatch: event=${voidedEv.payload.voided_reason}, CIL=${CEREMONY_VOIDED_REASON}`
          );
        }
        // 10. source_msg_id payload echo (§17.25)
        if (!voidedEv.payload || voidedEv.payload.source_msg_id !== CEREMONY_SOURCE_MSG_ID) {
          anomalies.push(
            `source_msg_id payload echo missing: payload=${JSON.stringify(voidedEv.payload)}`
          );
        }
      }

      // CRITICAL §3A DB-side: version row UNCHANGED post-void
      // 11. version.status unchanged
      if (after.v_status !== before.v_status) {
        anomalies.push(
          `version.status MUTATED post-void: pre='${before.v_status}' vs post='${after.v_status}' (§3A violation — version is unchanged across void)`
        );
      }
      // 12. version.sent_at unchanged
      if (before.v_sent_at && after.v_sent_at &&
          before.v_sent_at.getTime() !== after.v_sent_at.getTime()) {
        anomalies.push(
          `version.sent_at MUTATED post-void: pre=${before.v_sent_at.toISOString()} vs post=${after.v_sent_at.toISOString()} (§3A violation)`
        );
      }
      // 13. version.locked_at unchanged (NULL → NULL for sent source)
      const beforeLocked = before.v_locked_at?.getTime() ?? null;
      const afterLocked = after.v_locked_at?.getTime() ?? null;
      if (beforeLocked !== afterLocked) {
        anomalies.push(
          `version.locked_at MUTATED post-void: pre=${before.v_locked_at?.toISOString() ?? 'null'} vs post=${after.v_locked_at?.toISOString() ?? 'null'} (§3A violation)`
        );
      }
      // 14. version.server_hash unchanged (NULL → NULL for sent source)
      if (before.v_server_hash !== after.v_server_hash) {
        anomalies.push(
          `version.server_hash MUTATED post-void: pre=${before.v_server_hash} vs post=${after.v_server_hash} (§3A violation)`
        );
      }

      // Header-flip completeness
      // 15. quote.status='voided' post-void
      if (after.q_status !== 'voided') {
        anomalies.push(
          `post-state drift: quote.status=${after.q_status} (expected 'voided')`
        );
      }
      // 16. quote.voided_at populated post-void
      if (!after.q_voided_at) {
        anomalies.push(
          `post-state drift: quote.voided_at=${after.q_voided_at} (expected timestamp)`
        );
      }
      // 17. quote.voided_reason persisted post-void matches CIL input
      if (after.q_voided_reason !== CEREMONY_VOIDED_REASON) {
        anomalies.push(
          `post-state drift: quote.voided_reason=${after.q_voided_reason} (expected exact match to CIL input)`
        );
      }
    } else {
      // ── Already-voided retry expectations ───────────────────────────────
      // 1. No events emitted on retry
      if (result.meta.events_emitted.length !== 0) {
        anomalies.push(`events_emitted should be [] on retry, got ${JSON.stringify(result.meta.events_emitted)}`);
      }
      // 2. meta.already_existed=true on retry
      if (result.meta.already_existed !== true) {
        anomalies.push(`meta.already_existed=${result.meta.already_existed} (expected true on retry)`);
      }
      // 3. meta.correlation_id NULL on retry (§17.21 retry-path posture)
      if (result.meta.correlation_id !== null) {
        anomalies.push(`meta.correlation_id=${result.meta.correlation_id} (expected null on retry)`);
      }
      // 4. result.quote.status='voided' on retry
      if (result.quote.status !== 'voided') {
        anomalies.push(`result.quote.status=${result.quote.status} (expected 'voided' on retry)`);
      }
      // 5. voided_reason returned is PERSISTED original (§17.21 retry-path
      //    posture: silently drop current call's voided_reason)
      if (!result.quote.voided_reason) {
        anomalies.push(`result.quote.voided_reason falsy on retry — should be persisted original`);
      }
    }

    if (anomalies.length > 0) {
      console.error('[CEREMONY] ✗ ANOMALIES DETECTED — halting before §31 documentation:');
      for (const a of anomalies) console.error(`  - ${a}`);
      process.exit(3);
    }
    console.log('[CEREMONY] ✓ all anomaly-stop checks passed');
    console.log('');

    // ─── Captured §31 artifact values ──────────────────────────────────────
    console.log('─── Captured §31 artifact values ──────────────────────────');
    console.log(`correlation_id:        ${result.meta.correlation_id ?? 'NULL (retry path)'}`);
    console.log(`events_emitted:        ${JSON.stringify(result.meta.events_emitted)}`);
    console.log(`already_existed:       ${result.meta.already_existed}`);
    console.log(`quote.status:          ${result.quote.status}`);
    console.log(`quote.updated_at:      ${result.quote.updated_at}`);
    console.log(`quote.voided_at:       ${result.quote.voided_at ?? 'null'}`);
    console.log(`quote.voided_reason:   ${result.quote.voided_reason ?? 'null'}`);
    console.log(`version.status:        ${result.version.status}  (§3A — pass-through unchanged)`);
    console.log(`version.sent_at:       ${result.version.sent_at}  (§3A — unchanged)`);
    console.log(`version.locked_at:     ${result.version.locked_at ?? 'null'}  (§3A — unchanged)`);
    console.log(`version.server_hash:   ${result.version.server_hash ?? 'null'}  (§3A — unchanged)`);
    console.log('');
    console.log('Events captured above. Use these values to populate §31.');
    process.exit(0);
  } catch (err) {
    console.error('[CEREMONY] ✗ uncaught exception during handler invocation:');
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  }
})();
