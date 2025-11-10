// services/learning.js
const { query } = require('./postgres');

// Learn from validated events (CIL) after the domain handler succeeds.
async function learnFromEvent(ctx, cil) {
  // 1) Refresh last seen
  await query('UPDATE user_profiles SET last_seen_at=now() WHERE owner_id=$1', [ctx.owner_id]);

  // 2) Extract durable facts by CIL type (only validated fields)
  switch (cil?.type) {
    case 'Onboarding':
      if (cil.key != null) await upsertProfile(ctx.owner_id, cil.key, cil.value);
      break;

    case 'Clock':
      if (cil.job) await touchKnowledge(ctx.owner_id, 'job_name', cil.job);
      break;

    case 'Expense':
      if (cil.vendor) await touchKnowledge(ctx.owner_id, 'vendor', cil.vendor);
      break;

    case 'Quote':
      if (Array.isArray(cil.line_items)) {
        for (const li of cil.line_items) {
          if (li?.name) await touchKnowledge(ctx.owner_id, 'material', li.name);
        }
      }
      if (cil.customer && cil.customer.name) {
        await touchKnowledge(ctx.owner_id, 'customer', cil.customer.name);
      }
      break;

    default:
      break;
  }
}

// Merge a preference into user_profiles.preferences JSONB
async function upsertProfile(owner_id, key, value) {
  await query(
    `UPDATE user_profiles
       SET preferences = COALESCE(preferences,'{}'::jsonb) || jsonb_build_object($2,$3),
           updated_at = now()
     WHERE owner_id=$1`,
    [owner_id, key, value]
  );
}

// Increment or insert a knowledge item
async function touchKnowledge(owner_id, kind, key) {
  const canon = String(key || '').toLowerCase().trim();
  if (!canon) return;
  await query(`
    INSERT INTO tenant_knowledge(owner_id,kind,key)
    VALUES ($1,$2,$3)
    ON CONFLICT (owner_id,kind,key)
    DO UPDATE SET last_seen=now(), seen_count=tenant_knowledge.seen_count+1
  `, [owner_id, kind, canon]);
}

module.exports = { learnFromEvent };
