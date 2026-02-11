// src/lib/handleCapabilityDenied.js
// One-time upsell trigger memory (ACCOUNT-level)
// Stores flags on the OWNER row: where user_id = owner_id

const pg = require('../../services/postgres');

function normalizeFlagName(kind) {
  const k = String(kind || '').toLowerCase().trim();
  if (k === 'ocr') return 'ocr_upgrade_prompt_shown';
  if (k === 'stt') return 'stt_upgrade_prompt_shown';
  if (k === 'export_pdf' || k === 'export_xlsx' || k === 'export') return 'export_upgrade_prompt_shown';
  if (k === 'crew') return 'crew_upgrade_prompt_shown';
  return null;
}

async function shouldShowUpgradePromptOnce({ ownerId, kind }) {
  const owner = String(ownerId || '').trim(); // THIS is tenant key (1905...)
  const flagName = normalizeFlagName(kind);

  if (!owner || !flagName) return { shouldShow: false, flagName };

  try {
    // Read flag from OWNER row (user_id = owner_id)
    const sel = await pg.query(
      `
      select ${flagName} as shown
        from public.users
       where owner_id = $1
         and user_id = owner_id
       limit 1
      `,
      [owner]
    );

    const shown = !!sel?.rows?.[0]?.shown;
    if (shown) return { shouldShow: false, flagName };

    // Set it once
    await pg.query(
      `
      update public.users
         set ${flagName} = true
       where owner_id = $1
         and user_id = owner_id
      `,
      [owner]
    );

    return { shouldShow: true, flagName };
  } catch (e) {
    console.warn('[handleCapabilityDenied] failed (fail-closed):', e?.message);
    return { shouldShow: false, flagName };
  }
}

module.exports = { shouldShowUpgradePromptOnce };
