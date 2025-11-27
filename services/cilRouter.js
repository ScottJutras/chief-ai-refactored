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

const schemaMap = {
  CreateLead:        cilSchemas.CreateLead,
  CreateQuote:       cilSchemas.CreateQuote,
  CreateAgreement:   cilSchemas.CreateAgreement,
  CreateInvoice:     cilSchemas.CreateInvoice,
  CreateChangeOrder: cilSchemas.CreateChangeOrder, // fixed

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
  CreateChangeOrder: createChangeOrder,            // fixed

  LogExpense:        logExpense,
  LogRevenue:        logRevenue,

  AddPricingItem:    addPricingItem,
  UpdatePricingItem: updatePricingItem,
  DeletePricingItem: deletePricingItem,
};

// Entry point
async function applyCIL(rawCil, ctx) {
  if (!rawCil || !rawCil.type) {
    throw new Error('CIL missing type');
  }
  const schema = schemaMap[rawCil.type];
  if (!schema) throw new Error(`Unsupported CIL type: ${rawCil.type}`);

  // Validate & coerce
  const cil = schema.parse({ ...rawCil, owner_id: ctx.owner_id });

  // Dispatch
  const fn = handlerMap[cil.type];
  if (!fn) throw new Error(`No handler for CIL type: ${cil.type}`);

  const res = await fn(cil, ctx);
  // Return a unified summary for WhatsApp replies
  return {
    ok: true,
    type: cil.type,
    ...res,
    summary: res?.summary || `${cil.type} processed.`,
  };
}

module.exports = { applyCIL };
