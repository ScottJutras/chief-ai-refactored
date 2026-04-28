// services/activityLog.js
//
// Single write surface for public.chiefos_activity_logs (rebuild schema).
//
// Schema anchor: migrations/2026_04_21_rebuild_audit_observability.sql §1.
// Decision 12 REDESIGN: flat log (no child events table), dual actor FKs
// (portal_user_id → chiefos_portal_users OR actor_user_id → users), CHECK
// constraint requires at least one actor present.
//
// Canonical columns:
//   tenant_id (uuid NOT NULL)
//   owner_id (text NOT NULL)
//   portal_user_id (uuid NULL) — FK chiefos_portal_users
//   actor_user_id  (text NULL) — FK users
//   action_kind    (text NOT NULL, enum)
//   target_table   (text NOT NULL, regex ^[a-z][a-z_0-9]*$)
//   target_id      (text NOT NULL)
//   target_kind    (text NULL)
//   payload        (jsonb NOT NULL DEFAULT '{}')
//   trace_id       (text NOT NULL)
//   correlation_id (uuid NOT NULL)
//
// Append-only. GRANT posture: service_role INSERT/SELECT; authenticated SELECT only.
//
// R3 SCOPE NOTE: this module is the foundation for R3a (crew cluster rewrite).
// It is NOT called by the existing crew modules (routes/crewReview.js,
// routes/crewControl.js, services/crewControl.js) — those still emit against
// the pre-rebuild schema shape. Migrating those call sites is deferred to R3a
// per R3 scope STOP (directive §10.5 and §10.6).

const crypto = require('crypto');
const pg = require('./postgres');

const ACTION_KINDS = Object.freeze([
  'create', 'update', 'delete',
  'confirm', 'void', 'reject', 'export',
  'edit_confirm', 'reopen',
]);

const SOURCE_KINDS = Object.freeze([
  'whatsapp', 'portal', 'email', 'api', 'system', 'unknown',
]);

const TARGET_TABLE_RE = /^[a-z][a-z_0-9]{0,63}$/;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function coerceTraceId(maybe) {
  if (isNonEmptyString(maybe)) return maybe;
  return `trace_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function coerceCorrelationId(maybe) {
  if (isNonEmptyString(maybe)) return maybe;
  return crypto.randomUUID();
}

/**
 * Emit a single activity log entry.
 *
 * @param {object} actorContext - from services/actorContext.js buildActorContext(req).
 * @param {object} event - { action_kind, target_table, target_id, target_kind?, payload?, correlation_id? }.
 * @returns {Promise<{ ok: boolean, id?: string, error?: { code: string, message?: string, traceId?: string } }>}
 *
 * Failure modes are NON-throwing. Emission failures must not break upstream
 * business logic per Engineering Constitution §9 error handling principles.
 */
async function emitActivityLog(actorContext, event) {
  const traceId = coerceTraceId(actorContext?.traceId);

  if (!actorContext || !actorContext.tenantId || !actorContext.ownerId) {
    return { ok: false, error: { code: 'INVALID_ACTOR_CONTEXT', message: 'tenantId/ownerId required', traceId } };
  }
  if (!event || !ACTION_KINDS.includes(event.action_kind)) {
    return { ok: false, error: { code: 'INVALID_ACTION_KIND', message: `action_kind must be one of: ${ACTION_KINDS.join(',')}`, traceId } };
  }
  if (!isNonEmptyString(event.target_table) || !TARGET_TABLE_RE.test(event.target_table)) {
    return { ok: false, error: { code: 'INVALID_TARGET_TABLE', message: 'target_table must match ^[a-z][a-z_0-9]*$', traceId } };
  }
  if (!isNonEmptyString(event.target_id)) {
    return { ok: false, error: { code: 'INVALID_TARGET_ID', traceId } };
  }

  // Attribution: CHECK constraint requires portal_user_id OR actor_user_id.
  // actorId is the WhatsApp digit-string (→ actor_user_id).
  // portalUserId is the auth uuid (→ portal_user_id).
  const portalUserId = actorContext.portalUserId || null;
  const actorUserId = actorContext.actorId || null;

  if (!portalUserId && !actorUserId) {
    return {
      ok: false,
      error: {
        code: 'NO_ACTOR_ATTRIBUTION',
        message: 'Either portal_user_id or actor_user_id must be present on actorContext',
        traceId,
      },
    };
  }

  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  // Fold source + sourceMsgId into payload so the flat schema still carries
  // the audit context Decision 12's redesign doesn't express as columns.
  const wrappedPayload = {
    ...payload,
    _source: actorContext.source || 'unknown',
    _sourceMsgId: actorContext.sourceMsgId || null,
    _actorRole: actorContext.actorRole || null,
  };

  const correlationId = coerceCorrelationId(event.correlation_id);

  try {
    const { rows } = await pg.query(
      `
      insert into public.chiefos_activity_logs
        (tenant_id, owner_id, portal_user_id, actor_user_id, action_kind,
         target_table, target_id, target_kind, payload, trace_id, correlation_id, created_at)
      values
        ($1::uuid, $2, $3::uuid, $4, $5,
         $6, $7, $8, $9::jsonb, $10, $11::uuid, now())
      returning id
      `,
      [
        actorContext.tenantId,
        actorContext.ownerId,
        portalUserId,
        actorUserId,
        event.action_kind,
        event.target_table,
        event.target_id,
        event.target_kind || null,
        JSON.stringify(wrappedPayload),
        traceId,
        correlationId,
      ]
    );
    return { ok: true, id: rows[0]?.id };
  } catch (e) {
    console.warn('[activityLog] emit failed:', {
      traceId,
      action_kind: event.action_kind,
      target_table: event.target_table,
      error: e?.message,
    });
    return {
      ok: false,
      error: { code: 'ACTIVITY_LOG_WRITE_FAILED', message: e?.message || 'unknown', traceId },
    };
  }
}

/**
 * Bulk variant — shares actorContext across multiple events. Emits each
 * individually to preserve per-row id returns; if you need cross-event
 * atomicity, wrap in a pg transaction at the call site.
 *
 * @param {object} actorContext
 * @param {object[]} events
 * @returns {Promise<{ ok: boolean, count?: number, ids?: string[], error?: object, failures?: object[] }>}
 */
async function emitActivityLogBatch(actorContext, events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: true, count: 0, ids: [] };
  }

  const ids = [];
  const failures = [];
  for (const event of events) {
    const r = await emitActivityLog(actorContext, event);
    if (r.ok) {
      ids.push(r.id);
    } else {
      failures.push({ event, error: r.error });
    }
  }

  if (failures.length === 0) return { ok: true, count: ids.length, ids };
  return { ok: false, count: ids.length, ids, failures };
}

module.exports = {
  emitActivityLog,
  emitActivityLogBatch,
  ACTION_KINDS,
  SOURCE_KINDS,
};
