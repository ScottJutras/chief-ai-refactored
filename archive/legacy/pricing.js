// handlers/commands/pricing.js
const {
  addPricingItem,
  getPricingItems,
  updatePricingItem,
  deletePricingItem
} = require('../../services/postgres.js');
const { sendTemplateMessage } = require('../../services/twilio.js');

async function handlePricing(from, input, userProfile, ownerId, _, isOwner, res) {
  if (!isOwner) {
    await sendTemplateMessage(from, [{ type:'text', text: '⚠️ Only the owner can manage pricing.' }]);
    return res.send('<Response></Response>');
  }

  // add material <name> at $<cost>
  let m = input.match(/^add material\s+(.+)\s+at\s+\$(\d+(?:\.\d{1,2})?)$/i);
  if (m) {
    const [, name, cost] = m;
    await addPricingItem(ownerId, name.trim(), parseFloat(cost), 'each', 'material');
    await sendTemplateMessage(from, [{ type:'text', text: `✅ Added '${name}' @ $${cost}` }]);
    return res.send('<Response></Response>');
  }

  // list materials
  if (/^list materials$/i.test(input)) {
    const items = await getPricingItems(ownerId);
    const lines = items.map(i => `• ${i.item_name}: $${i.unit_cost}/${i.unit}`);
    await sendTemplateMessage(from, [{ type:'text', text: lines.join('\n') || 'No materials yet.' }]);
    return res.send('<Response></Response>');
  }

  // update material <name> to $<cost>
  m = input.match(/^update material\s+(.+)\s+to\s+\$(\d+(?:\.\d{1,2})?)$/i);
  if (m) {
    const [, name, cost] = m;
    await updatePricingItem(ownerId, name.trim(), parseFloat(cost));
    await sendTemplateMessage(from, [{ type:'text', text: `✅ Updated '${name}' to $${cost}` }]);
    return res.send('<Response></Response>');
  }

  // delete material <name>
  m = input.match(/^delete material\s+(.+)$/i);
  if (m) {
    const [, name] = m;
    await deletePricingItem(ownerId, name.trim());
    await sendTemplateMessage(from, [{ type:'text', text: `✅ Deleted '${name}'` }]);
    return res.send('<Response></Response>');
  }

  // not a pricing command—pass through
  return null;
}

module.exports = { handlePricing };
