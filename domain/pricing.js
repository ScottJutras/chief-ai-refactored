// domain/pricing.js
const { query } = require('../services/postgres');

async function addPricingItem(cil, ctx) {
  await query(
    `insert into public.pricing_items (owner_id, item_name, unit, unit_cost_cents, kind, created_at)
     values ($1,$2,$3,$4,$5,now())
     on conflict (owner_id, item_name) do nothing`,
    [ctx.owner_id, cil.item_name, cil.unit || 'each', cil.unit_cost_cents, cil.kind || 'material']
  );
  return { ok: true, summary: `✅ Added '${cil.item_name}' @ $${(cil.unit_cost_cents/100).toFixed(2)}/${cil.unit || 'each'}` };
}

async function updatePricingItem(cil, ctx) {
  const { rowCount } = await query(
    `update public.pricing_items set unit_cost_cents=$3 where owner_id=$1 and item_name=$2`,
    [ctx.owner_id, cil.item_name, cil.unit_cost_cents]
  );
  return {
    ok: true,
    summary: rowCount
      ? `✅ Updated '${cil.item_name}' to $${(cil.unit_cost_cents/100).toFixed(2)}`
      : `⚠️ '${cil.item_name}' not found`,
  };
}

async function deletePricingItem(cil, ctx) {
  const { rowCount } = await query(
    `delete from public.pricing_items where owner_id=$1 and item_name=$2`,
    [ctx.owner_id, cil.item_name]
  );
  return { ok: true, summary: rowCount ? `✅ Deleted '${cil.item_name}'` : `⚠️ '${cil.item_name}' not found` };
}

module.exports = { addPricingItem, updatePricingItem, deletePricingItem };
