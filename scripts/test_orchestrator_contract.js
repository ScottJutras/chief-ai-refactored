// scripts/test_orchestrator_contract.js
require('../config/env');

const { orchestrate } = require('../services/orchestrator');

(async () => {
  try {
    const from = process.env.TEST_FROM || '+19055551234';
    const ownerId = process.env.TEST_OWNER_ID || process.env.OWNER_ID || '19053279955';

    // Minimal profile for router + insights
    const userProfile = {
      tz: 'America/Toronto',
      plan: 'pro',
      subscription_tier: 'pro'
    };

    const text = process.argv.slice(2).join(' ').trim() || 'How am I doing this month?';

    const out = await orchestrate({
      from,
      text,
      userProfile,
      ownerId,
      returnContract: true
    });

    console.log('\n--- ORCHESTRATOR CONTRACT OUTPUT ---\n');
    console.log(JSON.stringify(out, null, 2));
    console.log('\n-----------------------------------\n');
    process.exit(0);
  } catch (e) {
    console.error('[test_orchestrator_contract] failed:', e?.message);
    process.exit(1);
  }
})();
