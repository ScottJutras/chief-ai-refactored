// services/cilRouter.js
// Central CIL dispatcher:
// - Validates payload with the correct Zod schema
// - Normalizes ctx (owner_id, actor_phone, source_msg_id)
// - Attaches normalized media meta for domain handlers
// - Returns a consistent { ok, type, summary, ... } envelope

const { cilSchemas } = require('../cil');

// Domain handlers
const { createLead } = require('../domain/lead');
const { createQuote } = require('../domain/quote');
const { createAgreement } = require('../domain/agreement');
const { createInvoice } = require('../domain/invoice');
const { createChangeOrder } = require('../domain/changeOrder');
const { logExpense, logRevenue } = require('../domain/transactions');
const { addPricingItem, updatePricingItem, deletePricingItem } = require('../domain/pricing');

// Prefer postgres.normalizeMediaMeta if present (your newer postgres.js has it)
let normalizeMediaMeta = null;
try {
  ({ normalizeMediaMeta } = require('./postgres'));
} catch {
  // fail-open
  normalizeMediaMeta = (m) => (m && typeof m === 'object' ? m : null);
}

const schemaMap = {
  CreateLead: cilSchemas?.CreateLead,
  CreateQuote: cilSchemas?.CreateQuote,
  CreateAgreement: cilSchemas?.CreateAgreement,
  CreateInvoice: cilSchemas?.CreateInvoice,
  CreateChangeOrder: cilSchemas?.CreateChangeOrder,

  LogExpense: cilSchemas?.LogExpense,
  LogRevenue: cilSchemas?.LogRevenue,

  AddPricingItem: cilSchemas?.AddPricingItem,
  UpdatePricingItem: cilSchemas?.UpdatePricingItem,
  DeletePricingItem: cilSchemas?.DeletePricingItem,
};

const handlerMap = {
  CreateLead: createLead,
  CreateQuote: createQuote,
  CreateAgreement: createAgreement,
  CreateInvoice: createInvoice,
  CreateChangeOrder: createChangeOrder,

  LogExpense: logExpense,
  LogRevenue: logRevenue,

  AddPricingItem: addPricingItem,
  UpdatePricingItem: updatePricingItem,
  DeletePricingItem: deletePricingItem,
};

function safeStr(x) {
  const s = String(x ?? '').trim();
  return s || null;
}

function buildMediaMetaFromCil(rawCil) {
  // Accept legacy naming variants (do NOT force into schema fields)
  const url = safeStr(rawCil?.media_url || rawCil?.mediaUrl);
  const type = safeStr(rawCil?.media_type || rawCil?.mediaType);
  const transcript = rawCil?.media_transcript || rawCil?.mediaTranscript || null;
  const confidence =
    rawCil?.media_confidence ?? rawCil?.mediaConfidence ?? null;

  if (!url && !type && !transcript && confidence == null) return null;
  return { url, type, transcript, confidence };
}

async function applyCIL(rawCil, ctx) {
  if (!rawCil || typeof rawCil !== 'object') {
    throw new Error('CIL payload missing');
  }
  if (!rawCil.type) {
    throw new Error('CIL missing type');
  }

  const schema = schemaMap[rawCil.type];
  if (!schema || typeof schema.parse !== 'function') {
    throw new Error(`Unsupported CIL type: ${rawCil.type}`);
  }

  const baseCtx = ctx && typeof ctx === 'object' ? ctx : {};

  // Tenant safety: require owner_id (UUID/text supported)
  const owner_id =
    safeStr(baseCtx.owner_id) ||
    safeStr(baseCtx.ownerId) ||
    safeStr(rawCil.owner_id) ||
    safeStr(rawCil.ownerId) ||
    null;

  if (!owner_id) {
    throw new Error('Missing ctx.owner_id');
  }

  const actor_phone =
    safeStr(baseCtx.actor_phone) ||
    safeStr(baseCtx.actorPhone) ||
    safeStr(baseCtx.from) ||
    safeStr(baseCtx.actor) ||
    null;

  const source_msg_id =
    safeStr(baseCtx.source_msg_id) ||
    safeStr(baseCtx.sourceMsgId) ||
    safeStr(baseCtx.messageSid) ||
    null;

  // Prefer ctx media meta (pendingMediaMeta from state) then fall back to CIL embedded fields
  const ctxMedia =
    baseCtx.mediaMeta ||
    baseCtx.pendingMediaMeta ||
    baseCtx.media_meta ||
    null;

  const cilMedia = buildMediaMetaFromCil(rawCil);

  const mediaMetaNormalized = normalizeMediaMeta(ctxMedia || cilMedia);

  // Only fill media_url if the schema supports it AND caller omitted it.
  const effectiveMediaUrl =
    safeStr(rawCil?.media_url || rawCil?.mediaUrl) ||
    safeStr(mediaMetaNormalized?.media_url) ||
    safeStr(mediaMetaNormalized?.url) ||
    null;

  const cilInput = {
    ...rawCil,
    owner_id,
  };

  // Best-effort: add media_url only if undefined (don’t override intentional null)
  if (effectiveMediaUrl && typeof cilInput.media_url === 'undefined') {
    cilInput.media_url = effectiveMediaUrl;
  }

  // Validate & coerce
  let cil;
  try {
    cil = schema.parse(cilInput);
  } catch (e) {
    const msg = e?.message || 'CIL schema validation failed';
    const err = new Error(msg);
    err.cil_type = rawCil.type;
    throw err;
  }

  const fn = handlerMap[cil.type];
  if (!fn) throw new Error(`No handler for CIL type: ${cil.type}`);

  const ctxOut = {
    ...baseCtx,
    owner_id,
    actor_phone,
    source_msg_id,

    // Preferred: domain handlers can persist full attachment meta
    mediaMetaNormalized,

    // Back-compat conveniences
    media_url: effectiveMediaUrl,
  };

  const result = await fn(cil, ctxOut);

  return {
    ok: true,
    type: cil.type,
    ...(result || {}),
    summary: result?.summary || `${cil.type} processed.`,
  };
}

module.exports = { applyCIL };
