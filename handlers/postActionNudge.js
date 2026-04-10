// handlers/postActionNudge.js
// Post-action guided actions: contextual WhatsApp nudges after first expense,
// first revenue, and when job P&L becomes meaningful.
//
// Call: await sendPostActionNudge({ ownerId, fromPhone, kind, jobId, jobName })
// - kind: 'expense_saved' | 'revenue_saved'
// - Fires at most once per nudge type per owner (tracked in public.settings)
// - Never blocks the main reply — call fire-and-forget

'use strict';

const pg = require('../services/postgres');

let sendQuickReply;
try { ({ sendQuickReply } = require('../services/twilio')); } catch {}

const PORTAL_URL = () =>
  String(process.env.PORTAL_BASE_URL || process.env.APP_BASE_URL || 'https://app.usechiefos.com').replace(/\/$/, '');

// YouTube video links — configure in env, fall back to empty (skipped if unset)
const VIDEOS = {
  expense: () => process.env.YOUTUBE_EXPENSE_GUIDE || '',
  jobpnl:  () => process.env.YOUTUBE_JOB_PNL_GUIDE || '',
  exports: () => process.env.YOUTUBE_EXPORTS_GUIDE || '',
};

function dbQuery(sql, params = []) {
  if (pg?.query) return pg.query(sql, params);
  if (pg?.pool?.query) return pg.pool.query(sql, params);
  throw new Error('no db query');
}

async function getNudgeSetting(ownerId, key) {
  try {
    const r = await dbQuery(
      `SELECT value FROM public.settings WHERE owner_id = $1 AND key = $2 LIMIT 1`,
      [String(ownerId), key]
    );
    return r?.rows?.[0]?.value ?? null;
  } catch { return null; }
}

async function setNudgeSetting(ownerId, key) {
  try {
    await dbQuery(
      `INSERT INTO public.settings (owner_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, key) DO UPDATE SET value = excluded.value, updated_at = NOW()`,
      [String(ownerId), key, String(Date.now())]
    );
  } catch {}
}

async function getExpenseCount(ownerId, jobId) {
  try {
    const r = await dbQuery(
      `SELECT COUNT(*)::int AS n FROM public.transactions
       WHERE owner_id::text = $1 AND kind = 'expense'
         ${jobId ? 'AND job_id = $2' : ''}`,
      jobId ? [String(ownerId), jobId] : [String(ownerId)]
    );
    return r?.rows?.[0]?.n ?? 0;
  } catch { return 0; }
}

async function getJobPnlSnapshot(ownerId, jobId) {
  try {
    const r = await dbQuery(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'revenue' THEN amount_cents ELSE 0 END), 0) AS rev,
         COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_cents ELSE 0 END), 0) AS exp
       FROM public.transactions
       WHERE owner_id::text = $1 AND job_id = $2`,
      [String(ownerId), jobId]
    );
    const rev = Number(r?.rows?.[0]?.rev || 0);
    const exp = Number(r?.rows?.[0]?.exp || 0);
    return { rev, exp };
  } catch { return null; }
}

async function maybeWrap(fn) {
  try { return await fn(); } catch (e) { console.warn('[NUDGE] error:', e?.message); return null; }
}

/**
 * sendPostActionNudge — fire-and-forget; call from webhook after action confirmed
 *
 * @param {object} opts
 * @param {string} opts.ownerId
 * @param {string} opts.fromPhone  — E.164 with country code, no 'whatsapp:' prefix
 * @param {'expense_saved'|'revenue_saved'} opts.kind
 * @param {string|number|null} opts.jobId
 * @param {string|null} opts.jobName
 */
async function sendPostActionNudge({ ownerId, fromPhone, kind, jobId, jobName }) {
  if (!ownerId || !fromPhone || !sendQuickReply) return;

  // ── Nudge: first expense ever → show what to do next ──────────────────────
  if (kind === 'expense_saved') {
    const alreadySent = await getNudgeSetting(ownerId, 'nudge.first_expense_sent');
    if (!alreadySent) {
      const totalExpenses = await getExpenseCount(ownerId, null);
      if (totalExpenses === 1) {
        await setNudgeSetting(ownerId, 'nudge.first_expense_sent');
        const videoUrl = VIDEOS.expense();
        const portal = PORTAL_URL();
        const lines = [
          `💡 First expense logged! Here's what you can do now:`,
          ``,
          `• Log more: expense $50 Canadian Tire`,
          `• Add revenue: revenue $1200 deposit`,
          `• Check job P&L: job kpis ${jobName || 'job name'}`,
          ``,
          `Everything shows up in your portal: ${portal}`,
        ];
        if (videoUrl) {
          lines.push(``, `📺 2-min walkthrough: ${videoUrl}`);
        }
        await maybeWrap(() => sendQuickReply(`+${fromPhone.replace(/^\+/, '')}`, lines.join('\n')));
        return;
      }
    }

    // ── Nudge: 3+ expenses on a job with revenue → show job P&L ─────────────
    if (jobId) {
      const nudgeKey = `nudge.job_pnl_shown_${jobId}`;
      const alreadyShownPnl = await getNudgeSetting(ownerId, nudgeKey);
      if (!alreadyShownPnl) {
        const jobExpenseCount = await getExpenseCount(ownerId, jobId);
        if (jobExpenseCount >= 3) {
          const snap = await getJobPnlSnapshot(ownerId, jobId);
          if (snap && snap.rev > 0) {
            await setNudgeSetting(ownerId, nudgeKey);
            const netCents = snap.rev - snap.exp;
            const margin = Math.round((netCents / snap.rev) * 100);
            const fmt = (c) => `$${(Math.abs(c) / 100).toFixed(0)}`;
            const videoUrl = VIDEOS.jobpnl();
            const lines = [
              `📊 ${jobName || 'Your job'} is building a real P&L:`,
              ``,
              `Revenue:  ${fmt(snap.rev)}`,
              `Expenses: ${fmt(snap.exp)}`,
              `Margin:   ${netCents >= 0 ? '+' : '-'}${fmt(Math.abs(netCents))} (${margin >= 0 ? margin : 0}%)`,
              ``,
              `Text "job kpis ${jobName || 'job name'}" any time for a full breakdown.`,
            ];
            if (videoUrl) {
              lines.push(``, `📺 Job P&L explained: ${videoUrl}`);
            }
            await maybeWrap(() => sendQuickReply(`+${fromPhone.replace(/^\+/, '')}`, lines.join('\n')));
          }
        }
      }
    }
  }

  // ── Nudge: first revenue → show export capabilities ──────────────────────
  if (kind === 'revenue_saved') {
    const alreadySent = await getNudgeSetting(ownerId, 'nudge.first_revenue_sent');
    if (!alreadySent) {
      const r = await dbQuery(
        `SELECT COUNT(*)::int AS n FROM public.transactions WHERE owner_id::text = $1 AND kind = 'revenue'`,
        [String(ownerId)]
      ).catch(() => null);
      const count = r?.rows?.[0]?.n ?? 0;
      if (count === 1) {
        await setNudgeSetting(ownerId, 'nudge.first_revenue_sent');
        const portal = PORTAL_URL();
        const videoUrl = VIDEOS.exports();
        const lines = [
          `💰 First revenue logged!`,
          ``,
          `Now Chief can show you job profitability. Text: job kpis ${jobName || 'job name'}`,
          ``,
          `Your portal: ${portal}/app/dashboard`,
        ];
        if (videoUrl) {
          lines.push(``, `📺 Learn about exports: ${videoUrl}`);
        }
        await maybeWrap(() => sendQuickReply(`+${fromPhone.replace(/^\+/, '')}`, lines.join('\n')));
      }
    }
  }
}

module.exports = { sendPostActionNudge };
