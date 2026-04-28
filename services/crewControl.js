// services/crewControl.js
// ============================================================================
// Crew submission/review state-transition helpers (R3b rewrite, 2026-04-24).
//
// REPLACES the pre-rebuild service that wrote to chiefos_activity_logs (with
// type/content_text/structured/status/log_no columns) and chiefos_activity_log_events
// child table — both DISCARDed per FOUNDATION §3.11 / Decision 12.
//
// New model: crew submissions land as canonical rows on time_entries_v2 / tasks
// with submission_status='pending_review' (per P1A-5 amendment §17l). Owner
// review transitions submission_status; every transition emits one
// chiefos_activity_logs row via the canonical emitActivityLog helper.
//
// State→action_kind mapping (R3a F2 decision):
//   approved              → 'confirm'
//   rejected              → 'reject'
//   needs_clarification   → 'update'  (payload describes the request)
//   pending_review        → 'update'  (crew clarification response)
//
// Tenant boundary (Engineering Constitution §3): every UPDATE filters by
//   id + tenant_id + owner_id. Never id alone.
// ============================================================================

const { query } = require('./postgres');
const { emitActivityLog, ACTION_KINDS } = require('./activityLog');
const { buildActorContext } = require('./actorContext');

const VALID_TARGET_TABLES = new Set(['time_entries_v2', 'tasks']);
const VALID_NEW_STATUS = new Set(['approved', 'rejected', 'needs_clarification', 'pending_review']);
const STATE_TO_ACTION = Object.freeze({
  approved: 'confirm',
  rejected: 'reject',
  needs_clarification: 'update',
  pending_review: 'update',
});

function ensureBoundary(ctx, label) {
  if (!ctx?.tenantId || !ctx?.ownerId) {
    const err = new Error(`[crewControl] ${label}: tenant/owner boundary missing`);
    err.code = 'TENANT_BOUNDARY_MISSING';
    throw err;
  }
}

// Owner inbox: list canonical rows with submission_status pending_review or
// needs_clarification, scoped by tenant. Cross-table union; sorted by created_at.
async function listPendingForReview(req, { limit = 100 } = {}) {
  const ctx = buildActorContext(req);
  ensureBoundary(ctx, 'listPendingForReview');
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));

  const r = await query(
    `select * from (
       select
         'time_entries_v2'::text as target_table,
         t.id::text               as id,
         t.user_id                as submitter_user_id,
         t.submission_status,
         t.created_at,
         jsonb_build_object(
           'kind', t.kind,
           'job_id', t.job_id,
           'start_at_utc', t.start_at_utc,
           'end_at_utc', t.end_at_utc,
           'meta', t.meta
         ) as detail
       from public.time_entries_v2 t
       where t.tenant_id = $1::uuid
         and t.submission_status in ('pending_review','needs_clarification')

       union all

       select
         'tasks'::text            as target_table,
         k.id::text               as id,
         coalesce(k.created_by_user_id, '') as submitter_user_id,
         k.submission_status,
         k.created_at,
         jsonb_build_object(
           'task_no', k.task_no,
           'title', k.title,
           'job_id', k.job_id,
           'status', k.status
         ) as detail
       from public.tasks k
       where k.tenant_id = $1::uuid
         and k.submission_status in ('pending_review','needs_clarification')
     ) u
     order by created_at desc
     limit ${lim}`,
    [ctx.tenantId]
  );

  return r?.rows || [];
}

// Crew → submit: flip an existing 'approved' canonical row to 'pending_review'.
// Used when crew explicitly resubmits after a needs_clarification, or for
// out-of-band crew submission flows. INSERT-with-pending-status is done at
// the callsite (e.g., routes/timeclock.js) instead — this helper handles
// the explicit transition path.
async function submitForReview(req, { target_table, target_id }) {
  if (!VALID_TARGET_TABLES.has(target_table)) {
    throw new Error(`[crewControl] invalid target_table: ${target_table}`);
  }
  const ctx = buildActorContext(req);
  ensureBoundary(ctx, 'submitForReview');

  const upd = await query(
    `update public.${target_table}
        set submission_status = 'pending_review', updated_at = now()
      where id::text = $1
        and tenant_id = $2::uuid
        and owner_id = $3
        and submission_status in ('approved','needs_clarification')
      returning id::text as id, submission_status`,
    [String(target_id), ctx.tenantId, ctx.ownerId]
  );
  if (!upd?.rowCount) {
    return { ok: false, error: { code: 'NOT_FOUND_OR_OUT_OF_TENANT' } };
  }

  const emit = await emitActivityLog(ctx, {
    action_kind: 'update',
    target_table,
    target_id: String(target_id),
    payload: { from: 'approved_or_clarification', to: 'pending_review', reason: 'crew_submitted' },
  });
  if (!emit?.ok) {
    return { ok: false, error: emit?.error || { code: 'ACTIVITY_EMIT_FAILED' } };
  }

  return { ok: true, target_table, target_id, new_status: 'pending_review' };
}

// Owner review action: transition submission_status + emit activity log.
async function transitionSubmissionStatus(req, { target_table, target_id, new_status, note = null }) {
  if (!VALID_TARGET_TABLES.has(target_table)) {
    throw new Error(`[crewControl] invalid target_table: ${target_table}`);
  }
  if (!VALID_NEW_STATUS.has(new_status)) {
    throw new Error(`[crewControl] invalid new_status: ${new_status}`);
  }
  const action = STATE_TO_ACTION[new_status];
  if (!ACTION_KINDS.includes(action)) {
    throw new Error(`[crewControl] mapped action_kind not in spec: ${action}`);
  }

  const ctx = buildActorContext(req);
  ensureBoundary(ctx, 'transitionSubmissionStatus');

  // Capture prior status for the payload.
  const prior = await query(
    `select submission_status from public.${target_table}
      where id::text = $1 and tenant_id = $2::uuid and owner_id = $3
      limit 1`,
    [String(target_id), ctx.tenantId, ctx.ownerId]
  );
  if (!prior?.rows?.length) {
    return { ok: false, error: { code: 'NOT_FOUND_OR_OUT_OF_TENANT' } };
  }
  const previous_status = prior.rows[0].submission_status;

  const upd = await query(
    `update public.${target_table}
        set submission_status = $4, updated_at = now()
      where id::text = $1 and tenant_id = $2::uuid and owner_id = $3
      returning id::text as id`,
    [String(target_id), ctx.tenantId, ctx.ownerId, new_status]
  );
  if (!upd?.rowCount) {
    return { ok: false, error: { code: 'UPDATE_NO_MATCH' } };
  }

  const payload = { from: previous_status, to: new_status };
  if (note) payload.note = String(note).trim().slice(0, 1000);

  const emit = await emitActivityLog(ctx, {
    action_kind: action,
    target_table,
    target_id: String(target_id),
    payload,
  });
  if (!emit?.ok) {
    return { ok: false, error: emit?.error || { code: 'ACTIVITY_EMIT_FAILED' } };
  }

  return { ok: true, target_table, target_id, new_status, previous_status };
}

// DEPRECATED stub for routes/webhook.js's crew WhatsApp ingestion path. Crew
// self-logging via WhatsApp is OUT OF R3b scope (separate Pro-tier surface)
// per directive. Returns ok:false envelope; webhook caller already handles
// missing function gracefully (lazy-load + null-check pattern).
async function createCrewActivityLog(_args = {}) {
  console.warn('[CREW_CONTROL] createCrewActivityLog is deprecated; crew WhatsApp ingestion path requires separate remediation (R3b out-of-scope).');
  return {
    ok: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Crew WhatsApp ingestion path replaced post-R3b; use canonical INSERT + emitActivityLog directly.',
    },
  };
}

module.exports = {
  listPendingForReview,
  submitForReview,
  transitionSubmissionStatus,
  createCrewActivityLog,
  // exported for tests
  VALID_TARGET_TABLES,
  VALID_NEW_STATUS,
  STATE_TO_ACTION,
};
