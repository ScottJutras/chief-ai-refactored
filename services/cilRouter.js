// services/cilRouter.js
const { cilSchemas } = require('../cil');

// Domain handlers
const { createLead }        = require('../domain/lead');
const { createQuote }       = require('../domain/quote');
const { createAgreement }   = require('../domain/agreement');
const { createInvoice }     = require('../domain/invoice');
const { createChangeOrder } = require('../domain/changeOrder');
const { logExpense, logRevenue } = require('../domain/transactions');
const {
  addPricingItem,
  updatePricingItem,
  deletePricingItem
} = require('../domain/pricing');

// ✅ Pull in media normalization + truncation logic from the DB layer
let normalizeMediaMeta = null;
try {
  // Available after your postgres.js drop-in
  ({ normalizeMediaMeta } = require('./postgres'));
} catch {
  // fail-open
  normalizeMediaMeta = (m) => m || null;
}

const schemaMap = {
  CreateLead:        cilSchemas.CreateLead,
  CreateQuote:       cilSchemas.CreateQuote,
  CreateAgreement:   cilSchemas.CreateAgreement,
  CreateInvoice:     cilSchemas.CreateInvoice,
  CreateChangeOrder: cilSchemas.CreateChangeOrder,

  LogExpense:        cilSchemas.LogExpense,
  LogRevenue:        cilSchemas.LogRevenue,

  AddPricingItem:    cilSchemas.AddPricingItem,
  UpdatePricingItem: cilSchemas.UpdatePricingItem,
  DeletePricingItem: cilSchemas.DeletePricingItem,
};

const handlerMap = {
  CreateLead:        createLead,
  CreateQuote:       createQuote,
  CreateAgreement:   createAgreement,
  CreateInvoice:     createInvoice,
  CreateChangeOrder: createChangeOrder,

  LogExpense:        logExpense,
  LogRevenue:        logRevenue,

  AddPricingItem:    addPricingItem,
  UpdatePricingItem: updatePricingItem,
  DeletePricingItem: deletePricingItem,
};

function safeStr(x) {
  const s = String(x ?? '').trim();
  return s || null;
}

function buildMediaMetaFromCil(rawCil) {
  // If legacy CIL includes media_url only, still treat it as media meta
  const url = safeStr(rawCil?.media_url || rawCil?.mediaUrl);
  const type = safeStr(rawCil?.media_type || rawCil?.mediaType);
  const transcript = rawCil?.media_transcript || rawCil?.mediaTranscript || null;
  const confidence = rawCil?.media_confidence ?? rawCil?.mediaConfidence ?? null;

  if (!url && !type && !transcript && confidence == null) return null;
  return { url, type, transcript, confidence };
}

// Entry point
async function applyCIL(rawCil, ctx) {
  if (!rawCil || !rawCil.type) {
    throw new Error('CIL missing type');
  }

  const schema = schemaMap[rawCil.type];
  if (!schema) throw new Error(`Unsupported CIL type: ${rawCil.type}`);

  // ✅ Normalize ctx (fail-open; don’t crash if caller forgets something)
  const baseCtx = ctx && typeof ctx === 'object' ? ctx : {};

  const owner_id =
    safeStr(baseCtx.owner_id) ||
    safeStr(baseCtx.ownerId) ||
    safeStr(rawCil.owner_id) ||
    null;

  if (!owner_id) {
    // Keeping this strict is good for tenant safety.
    throw new Error('Missing ctx.owner_id');
  }

  // These aren’t always present, but we standardize them for auditability
  const actor_phone =
    safeStr(baseCtx.actor_phone) ||
    safeStr(baseCtx.actorPhone) ||
    safeStr(baseCtx.from) ||
    null;

  const source_msg_id =
    safeStr(baseCtx.source_msg_id) ||
    safeStr(baseCtx.sourceMsgId) ||
    null;

  // ✅ Media meta: prefer ctx.mediaMeta / ctx.pendingMediaMeta; fall back to any media fields in rawCil
  const ctxMedia =
    baseCtx.mediaMeta ||
    baseCtx.pendingMediaMeta ||
    baseCtx.media_meta ||
    null;

  const cilMedia = buildMediaMetaFromCil(rawCil);

  const mediaMetaNormalized = normalizeMediaMeta(ctxMedia || cilMedia);

  // ✅ Only set media_url onto the CIL payload if the schema already supports it.
  // (We do NOT add media_type/transcript/confidence to CIL because schemas likely don’t include them.)
  const effectiveMediaUrl =
    safeStr(rawCil?.media_url || rawCil?.mediaUrl) ||
    safeStr(mediaMetaNormalized?.media_url) ||
    null;

  // Build the object that goes through schema.parse (keep it schema-friendly)
  const cilInput = {
    ...rawCil,
    owner_id,
  };

  // Best-effort: if this CIL type supports media_url and caller omitted it, fill it
  if (effectiveMediaUrl && typeof cilInput.media_url === 'undefined') {
    cilInput.media_url = effectiveMediaUrl;
  }

  // Validate & coerce
  const cil = schema.parse(cilInput);

  // Dispatch
  const fn = handlerMap[cil.type];
  if (!fn) throw new Error(`No handler for CIL type: ${cil.type}`);

  // ✅ Provide standardized ctx to domain layer (audit + attachments)
  const ctxOut = {
    ...baseCtx,
    owner_id,
    actor_phone,
    source_msg_id,

    // Preferred: domain handlers can use this to persist media_url/type/transcript/confidence
    mediaMetaNormalized,

    // Back-compat conveniences (some older handlers might look here)
    media_url: effectiveMediaUrl,
  };

  const res = await fn(cil, ctxOut);

  // Return a unified summary for WhatsApp replies
  return {
    ok: true,
    type: cil.type,
    ...res,
    summary: res?.summary || `${cil.type} processed.`,
  };
}

module.exports = { applyCIL };
