// src/lib/handleCapabilityDenied.js
// Central one-time upsell trigger memory (MVP-safe, no auto-detection)

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
  const owner = String(ownerId || '').trim();
  const flagName = normalizeFlagName(kind);

  if (!owner || !flagName) {
    return { shouldShow: false, flagName };
  }

  try {
    // Read current flag
    const sel = await pg.query(
      `
      select ${flagName} as shown
      from public.users
      where user_id = $1
      limit 1
      `,
      [owner]
    );

    const shown = !!sel?.rows?.[0]?.shown;

    if (shown) {
      return { shouldShow: false, flagName };
    }

    // Set flag
    await pg.query(
      `
      update public.users
         set ${flagName} = true
       where user_id = $1
      `,
      [owner]
    );

    return { shouldShow: true, flagName };
  } catch (e) {
    console.warn('[handleCapabilityDenied] failed (fail-closed):', e?.message);
    return { shouldShow: false, flagName };
  }
}

module.exports = {
  shouldShowUpgradePromptOnce
};
