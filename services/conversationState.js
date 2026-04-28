// services/conversationState.js
// ============================================================================
// Conversation session + message helper (R4c-migrate, 2026-04-24).
//
// Replaces the legacy `chief_actor_memory` jsonb (DISCARDed per
// FOUNDATION_P1_SCHEMA_DESIGN.md row 1561) with the rebuild schema's
// `conversation_sessions.active_entities` (jsonb) + `conversation_messages`
// (per-turn rows) per §3.10.
//
// Identity contract (Engineering Constitution §2):
//   tenantId  uuid       — REQUIRED, throws TENANT_BOUNDARY_MISSING if absent
//   ownerId   text       — REQUIRED
//   userId    text       — REQUIRED (the actor; phone digits for WhatsApp)
//   source    'whatsapp' | 'portal' (default 'whatsapp')
//   traceId   text       — optional; minted if absent (NOT NULL on row)
//   correlationId uuid   — optional; minted if absent (per §17.21)
//
// TTL semantics (R4c-migrate D3):
//   Sessions are considered "active" if not ended AND last_activity_at within
//   CONVERSATION_SESSION_TTL_MS. Default 72 hours per directive (FOUNDATION
//   §3.10 mentions TTL abstractly without a numeric value). Configurable via
//   env var.
//   On access past TTL: any open expired session is closed (ended_at = now,
//   end_reason='timeout') and a fresh row created. Pre-rebuild's
//   single-forever-row behavior is intentionally NOT preserved — stale
//   pending_choice from 6-hour-old conversation should not bleed into a new
//   one.
//
// B1/B2 fix: every public function throws on missing identity rather than
//   silently returning {}/no-op. *Safe variants exist for callers that need
//   never-throw fire-and-forget; they swallow and log.
//
// Patch-merge semantics (R4c-migrate D1 — preserve nested):
//   `active_entities.conversation` is deep-merged (matches insights_v0
//   emission shape `{ conversation: {...} }`); other top-level keys are
//   shallow-merged via jsonb concatenation. Mirrors the
//   pre-rebuild patchActorMemory contract verbatim — minimal call-site churn.
// ============================================================================

const crypto = require('crypto');
const { query } = require('./postgres');

const TTL_MS = Number(process.env.CONVERSATION_SESSION_TTL_MS || 72 * 60 * 60 * 1000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_SOURCES = new Set(['whatsapp', 'portal']);
const VALID_ROLES = new Set(['user', 'chief', 'system', 'tool']);

function ensureCtx(ctx, label) {
  if (!ctx || typeof ctx !== 'object') {
    const err = new Error(`[conversationState] ${label}: ctx object is required`);
    err.code = 'ACTOR_CONTEXT_MISSING';
    throw err;
  }
  if (!ctx.tenantId || typeof ctx.tenantId !== 'string' || !UUID_RE.test(ctx.tenantId)) {
    const err = new Error(`[conversationState] ${label}: tenantId (uuid) is required`);
    err.code = 'TENANT_BOUNDARY_MISSING';
    throw err;
  }
  if (!ctx.ownerId || typeof ctx.ownerId !== 'string') {
    const err = new Error(`[conversationState] ${label}: ownerId is required`);
    err.code = 'OWNER_BOUNDARY_MISSING';
    throw err;
  }
  if (!ctx.userId || typeof ctx.userId !== 'string') {
    const err = new Error(`[conversationState] ${label}: userId (actor) is required`);
    err.code = 'ACTOR_BOUNDARY_MISSING';
    throw err;
  }
  const source = ctx.source || 'whatsapp';
  if (!VALID_SOURCES.has(source)) {
    const err = new Error(`[conversationState] ${label}: source must be whatsapp|portal (got ${source})`);
    err.code = 'INVALID_SOURCE';
    throw err;
  }
  return source;
}

async function getOrCreateActiveSession(ctx) {
  const source = ensureCtx(ctx, 'getOrCreateActiveSession');
  const ttlSec = Math.max(60, Math.floor(TTL_MS / 1000));

  const found = await query(
    `select id, active_entities, last_activity_at
       from public.conversation_sessions
      where tenant_id = $1::uuid
        and owner_id = $2
        and user_id = $3
        and ended_at is null
        and last_activity_at > now() - ($4 || ' seconds')::interval
      order by last_activity_at desc
      limit 1`,
    [ctx.tenantId, ctx.ownerId, ctx.userId, String(ttlSec)]
  );
  if (found?.rows?.length) return found.rows[0];

  // Close any open expired sessions for this actor
  await query(
    `update public.conversation_sessions
        set ended_at = now(), end_reason = 'timeout', updated_at = now()
      where tenant_id = $1::uuid
        and owner_id = $2
        and user_id = $3
        and ended_at is null`,
    [ctx.tenantId, ctx.ownerId, ctx.userId]
  );

  const traceId = ctx.traceId || ctx.correlationId || crypto.randomUUID();
  const created = await query(
    `insert into public.conversation_sessions
        (tenant_id, owner_id, user_id, source, trace_id, active_entities)
      values ($1::uuid, $2, $3, $4, $5, '{}'::jsonb)
      returning id, active_entities, last_activity_at`,
    [ctx.tenantId, ctx.ownerId, ctx.userId, source, traceId]
  );
  return created.rows[0];
}

async function getSessionState(ctx) {
  const session = await getOrCreateActiveSession(ctx);
  return (session?.active_entities && typeof session.active_entities === 'object')
    ? session.active_entities
    : {};
}

async function patchSessionState(ctx, patch) {
  ensureCtx(ctx, 'patchSessionState');
  const safePatch = patch && typeof patch === 'object' ? patch : {};
  const session = await getOrCreateActiveSession(ctx);
  const patchJson = JSON.stringify(safePatch);

  await query(
    `update public.conversation_sessions
        set active_entities =
          (
            active_entities
            || ($2::jsonb - 'conversation')
            || jsonb_build_object(
                 'conversation',
                 coalesce(active_entities->'conversation', '{}'::jsonb)
                 || coalesce(($2::jsonb)->'conversation', '{}'::jsonb)
               )
          ),
            last_activity_at = now(),
            updated_at = now()
      where id = $1::uuid`,
    [session.id, patchJson]
  );
}

async function appendMessage(ctx, { role, content, toolName = null, toolInput = null, toolOutput = null, sourceMsgId = null } = {}) {
  ensureCtx(ctx, 'appendMessage');
  if (!VALID_ROLES.has(role)) {
    const err = new Error(`[conversationState] appendMessage: role must be user|chief|system|tool (got ${role})`);
    err.code = 'INVALID_ROLE';
    throw err;
  }
  const session = await getOrCreateActiveSession(ctx);
  const traceId = ctx.traceId || ctx.correlationId || crypto.randomUUID();
  const correlationId = ctx.correlationId || crypto.randomUUID();
  const safeContent = String(content == null ? '' : content);
  const sm = sourceMsgId ? String(sourceMsgId).trim() || null : null;

  const inserted = await query(
    `insert into public.conversation_messages
        (session_id, tenant_id, owner_id, sequence_no, role, content,
         tool_name, tool_input, tool_output, source_msg_id, trace_id, correlation_id)
      values (
        $1::uuid, $2::uuid, $3,
        (select coalesce(max(sequence_no), 0) + 1
           from public.conversation_messages
          where session_id = $1::uuid),
        $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::uuid)
      on conflict (owner_id, source_msg_id) where source_msg_id is not null do nothing
      returning id, sequence_no`,
    [session.id, ctx.tenantId, ctx.ownerId, role, safeContent,
     toolName, toolInput ? JSON.stringify(toolInput) : null,
     toolOutput ? JSON.stringify(toolOutput) : null, sm, traceId, correlationId]
  );

  await query(
    `update public.conversation_sessions
        set last_activity_at = now(), updated_at = now()
      where id = $1::uuid`,
    [session.id]
  );

  return inserted?.rows?.[0] || null;
}

// Returns last N messages oldest→newest. Maps DB role 'chief' → 'assistant' so
// callers can feed directly into LLM message arrays.
async function getRecentMessages(ctx, { limit = 12 } = {}) {
  ensureCtx(ctx, 'getRecentMessages');
  const session = await getOrCreateActiveSession(ctx);
  const lim = Math.max(1, Math.min(Number(limit) || 12, 100));
  const r = await query(
    `select role, content, sequence_no
       from public.conversation_messages
      where session_id = $1::uuid
        and tenant_id = $2::uuid
        and role in ('user','chief')
      order by sequence_no desc
      limit ${lim}`,
    [session.id, ctx.tenantId]
  );
  return (r.rows || [])
    .reverse()
    .map(row => ({
      role: row.role === 'chief' ? 'assistant' : row.role,
      content: row.content,
    }));
}

async function getSessionStateSafe(ctx) {
  try { return await getSessionState(ctx); } catch (e) {
    console.warn('[conversationState] getSessionStateSafe failed:', e?.message);
    return {};
  }
}
async function patchSessionStateSafe(ctx, patch) {
  try { await patchSessionState(ctx, patch); } catch (e) {
    console.warn('[conversationState] patchSessionStateSafe failed:', e?.message);
  }
}
async function appendMessageSafe(ctx, args) {
  try { return await appendMessage(ctx, args); } catch (e) {
    console.warn('[conversationState] appendMessageSafe failed:', e?.message);
    return null;
  }
}
async function getRecentMessagesSafe(ctx, args) {
  try { return await getRecentMessages(ctx, args); } catch (e) {
    console.warn('[conversationState] getRecentMessagesSafe failed:', e?.message);
    return [];
  }
}

module.exports = {
  getSessionState,
  getSessionStateSafe,
  patchSessionState,
  patchSessionStateSafe,
  appendMessage,
  appendMessageSafe,
  getRecentMessages,
  getRecentMessagesSafe,
  TTL_MS,
};
