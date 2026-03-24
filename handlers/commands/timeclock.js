// handlers/commands/timeclock.js
// -------------------------------------------------------------------
// Timeclock — State Machine Enforced (North Star §4.2)
// Idempotent writes via source_msg_id (Twilio MessageSid when available)
// -------------------------------------------------------------------
//
// COMPLETE DROP-IN (aligned with latest patterns + expense/revenue identity model)
//
// ✅ Alignments added in THIS drop-in (without removing logic):
// - ✅ Canonical identity key for state + db lookups: paUserId = WaId || digits(from) (matches expense/revenue)
// - ✅ resolveJobNameForActor uses digits(identity) when calling getActiveJobForIdentity
// - ✅ stableMsgId prefers router sourceMsgId, then MessageSid (keeps idempotency consistent with other handlers)
// - ✅ pending_actions backfill saves under paUserId (not raw "from") when available
// - ✅ NEVER DIGITS(ownerId) (keeps UUID/text safe owner ids, as your file intended)
// - ✅ More “end/stop” synonyms for break/drive already present; kept as-is
// - ✅ Final lock release preserved
// -------------------------------------------------------------------

const pg = require('../../services/postgres');
const chrono = require('chrono-node');
const { formatInTimeZone, zonedTimeToUtc } = require('date-fns-tz');
const { getUserByName, getUserBasic } = require('../../services/users');
const { canLogTime } = require("../../src/config/checkCapability");
const { logCapabilityDenial } = require("../../src/lib/capabilityDenials");
const { PRO_CREW_UPGRADE_LINE, UPGRADE_FOLLOWUP_ASK } = require('../../src/config/upgradeCopy');
const { maybeGetCrewMomentText } = require('../../src/lib/upsellMoments');
const { checkMonthlyQuota, consumeMonthlyQuota } = require('../../utils/quota');
const { shouldShowUpgradePromptOnce } = require('../../src/lib/handleCapabilityDenied');
const { getEffectivePlanFromOwner } = require("../../src/config/effectivePlan");



// ---- safe Twilio helpers (do NOT crash if file moved/renamed) ----
let sendBackfillConfirm = async () => null;
let sendQuickReply = async () => null;
try {
  // eslint-disable-next-line global-require
  const tw = require('../../services/twilio');
  if (typeof tw.sendBackfillConfirm === 'function') sendBackfillConfirm = tw.sendBackfillConfirm;
  if (typeof tw.sendQuickReply === 'function') sendQuickReply = tw.sendQuickReply;
} catch {}

// ---- CIL (safe) ----
let ClockCIL = null;
try {
  // eslint-disable-next-line global-require
  ClockCIL = require('../../schemas/cil.clock')?.ClockCIL || null;
} catch {}

// ---- Constants ----
const ALLOW_LEGACY_FACT_EMIT = false; // 🔒 never flip on in prod paths


/* ---------------- Identity helpers (aligned to expense/revenue) ---------------- */

const DIGITS = (x) =>
  String(x ?? '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\D/g, '');

function normalizeIdentityDigits(x) {
  return DIGITS(x);
}

function getPaUserId(from, userProfile, reqBody) {
  const waId = reqBody?.WaId || reqBody?.waId || userProfile?.wa_id || userProfile?.waId || null;
  const a = normalizeIdentityDigits(waId);
  if (a) return a;

  const b = normalizeIdentityDigits(from);
  if (b) return b;

  // fallback only (should be rare)
  return String(from || '').trim();
}

/* ---------------- TwiML helpers ---------------- */

function xmlEsc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twiml(res, body) {
  res
    .status(200)
    .type('application/xml; charset=utf-8')
    .send(`<Response><Message>${xmlEsc(String(body || '').trim() || 'Timeclock error. Try again.')}</Message></Response>`);
  return true;
}

/* ---------------- Human formatting helpers ---------------- */

function toHumanTime(ts, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
  return f.format(new Date(ts)).replace(' AM', 'am').replace(' PM', 'pm');
}

function toHumanDate(ts, tz) {
  const d = new Date(ts);
  const dd = formatInTimeZone(d, tz, 'dd');
  const MM = formatInTimeZone(d, tz, 'MM');
  const yyyy = formatInTimeZone(d, tz, 'yyyy');
  return `${dd}-${MM}-${yyyy}`;
}

function humanVerb(type) {
  switch (type) {
    case 'clock_in':
    case 'punch_in':
      return 'clocked in';
    case 'clock_out':
    case 'punch_out':
      return 'clocked out';
    case 'break_start':
      return 'started their break';
    case 'break_stop':
    case 'break_end':
      return 'ended their break';
    case 'drive_start':
      return 'started driving';
    case 'drive_stop':
    case 'drive_end':
      return 'stopped driving';
    default:
      return String(type || '').replace('_', ' ');
  }
}

function humanLine(type, target, ts, tz) {
  return `${target} ${humanVerb(type)} ${toHumanTime(ts, tz)} on ${toHumanDate(ts, tz)}`;
}

/* ---------------- Schema probes (serverless-safe cached) ---------------- */

let _hasTimeEntriesSourceMsgIdCol = null;
let _timeEntriesShape = null; // 'new' | 'legacy' | 'unknown'

async function hasColumn(table, col) {
  const { rows } = await pg.query(
    `select 1
       from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
        and column_name = $2
      limit 1`,
    [table, col]
  );
  return (rows?.length || 0) > 0;
}

async function hasTimeEntriesSourceMsgIdColumn() {
  if (_hasTimeEntriesSourceMsgIdCol !== null) return _hasTimeEntriesSourceMsgIdCol;
  try {
    _hasTimeEntriesSourceMsgIdCol = await hasColumn('time_entries_v2', 'source_msg_id');
  } catch {
    // Don't cache transient errors — allow retry on next call
    return false;
  }
  return _hasTimeEntriesSourceMsgIdCol;
}


async function detectTimeEntriesShape() {
  if (_timeEntriesShape) return _timeEntriesShape;

  try {
    // Prefer v2 table (Option A)
    const hasV2 = await hasTable('time_entries_v2');
    if (hasV2) {
      const hasKind = await hasColumn('time_entries_v2', 'kind');
      const hasStartUtc = await hasColumn('time_entries_v2', 'start_at_utc');
      const hasEndUtc = await hasColumn('time_entries_v2', 'end_at_utc');

      if (hasKind && hasStartUtc && hasEndUtc) {
        _timeEntriesShape = 'new';
        return _timeEntriesShape;
      }
    }

    // Legacy fallback (original table)
    const hasEmployeeName = await hasColumn('time_entries', 'employee_name');
    const hasTimestamp = await hasColumn('time_entries', 'timestamp');
    const hasType = await hasColumn('time_entries', 'type');

    if (hasEmployeeName && hasTimestamp && hasType) _timeEntriesShape = 'legacy';
    else _timeEntriesShape = 'unknown';
  } catch {
    // Don't cache transient errors — allow retry on next call
    return 'unknown';
  }

  return _timeEntriesShape;
}

// helper (if you don't already have it)
async function hasTable(tableName) {
  const t = String(tableName || '').trim();
  if (!t) return false;
  try {
    const r = await pg.query(
      `select 1 from information_schema.tables where table_schema='public' and table_name=$1 limit 1`,
      [t]
    );
    return !!r?.rowCount;
  } catch {
    return false;
  }
}



/* ---------------- Idempotency / MsgId ---------------- */

function getTwilioMessageSidFromRes(res) {
  try {
    const b = res?.req?.body || {};
    return String(b.MessageSid || b.SmsMessageSid || '').trim() || null;
  } catch {
    return null;
  }
}


/* ---------------- Job resolution (active-job aware) ---------------- */

function extractJobHint(text = '') {
  const m = String(text).match(/@\s*([^\n\r]+)/);
  return m ? m[1].trim() : null;
}

/**
 * ✅ Align: use digits identity when calling pg.getActiveJobForIdentity
 * (ownerId remains string/uuid safe and is NOT digits-sanitized)
 */
async function resolveJobNameForActor({ ownerId, identityKey, explicitJobName }) {
  const j = String(explicitJobName || '').trim();
  if (j) return j;

  const ident = normalizeIdentityDigits(identityKey) || String(identityKey || '').trim();
  if (!ident) return null;

  if (typeof pg.getActiveJobForIdentity === 'function') {
    try {
      const out = await pg.getActiveJobForIdentity(String(ownerId).trim(), String(ident).trim());
      const name = out?.active_job_name || out?.activeJobName || out?.name || out?.job_name || null;
      if (name && String(name).trim()) return String(name).trim();
    } catch {}
  }
  return null;
}

/* ---------------- New-schema DB helpers (shift/children) ---------------- */

async function getOpenShift(owner_id, user_id) {
  const { rows } = await pg.query(
    `SELECT *
       FROM public.time_entries_v2
      WHERE owner_id = $1
        AND user_id = $2
        AND kind = 'shift'
        AND end_at_utc IS NULL
        AND deleted_at IS NULL
      ORDER BY start_at_utc DESC
      LIMIT 1`,
    [String(owner_id || '').trim(), String(user_id || '').trim()]
  );
  return rows[0] || null;
}


async function ensureNoOverlapChild(owner_id, parent_id, kind, atIso = null) {
  const at = atIso && !Number.isNaN(Date.parse(String(atIso)))
    ? new Date(String(atIso)).toISOString()
    : new Date().toISOString();

  await pg.query(
    `UPDATE public.time_entries_v2
        SET end_at_utc = $4, updated_at = now()
      WHERE owner_id = $1
        AND parent_id = $2
        AND kind = $3
        AND end_at_utc IS NULL`,
    [String(owner_id || '').trim(), parent_id, kind, at]
  );
}

async function closeEntryById(owner_id, id, atIso = null) {
  const at = atIso && !Number.isNaN(Date.parse(String(atIso)))
    ? new Date(String(atIso)).toISOString()
    : new Date().toISOString();

  const { rows } = await pg.query(
    `UPDATE public.time_entries_v2
        SET end_at_utc = $3, updated_at = now()
      WHERE owner_id = $1
        AND id = $2
        AND end_at_utc IS NULL
      RETURNING *`,
    [String(owner_id || '').trim(), id, at]
  );
  return rows[0] || null;
}

async function twimlWithTargetName(res, text, opts = {}) {
  const ownerId = opts.ownerId;
  const actorId = String(opts.actorId || '').replace(/\D/g, '') || null;

  // Support both keys: targetUserId (new) and targetId (older callsites)
  const targetUserIdRaw = opts.targetUserId || opts.targetId || null;
  const targetUserId = String(targetUserIdRaw || '').replace(/\D/g, '') || null;

  // ✅ allow caller to provide fallback display name (usually userProfile.name)
  const fallbackName =
    String(opts.fallbackName || '').trim() ||
    String(opts.fallbackTargetName || '').trim() ||
    '';

  let msg = String(text || '').trim() || 'Time logged.';

  // If we can’t identify a target, just return as-is
  if (!ownerId || !targetUserId) return twiml(res, msg);

  // ✅ Detect placeholder usage (if present, we should NOT append a suffix name)
  const hadNamePlaceholder = /\{name\}/i.test(msg);
  const hadTargetPlaceholder = /\{target\}/i.test(msg);
  const hadAnyPlaceholder = hadNamePlaceholder || hadTargetPlaceholder;

  try {
    // Prefer real display name via helper
    let display = '';
    try {
      if (typeof displayNameForUserId === 'function') {
        display = await displayNameForUserId(ownerId, targetUserId);
      }
    } catch {}

    // Fallback if lookup failed / blank
    if (!display) display = fallbackName;

    // If still nothing, just return original message
    if (!display) return twiml(res, msg);

    const disp = String(display).trim();
    const dispFirst = disp.split(/\s+/)[0] || '';
    const dispFirstLc = dispFirst.toLowerCase();
    const msgLc = msg.toLowerCase();
    const dispLc = disp.toLowerCase();

    // ✅ Replace placeholder(s) with FIRST name (Scott) not full name (Scott Jutras)
    if (hadAnyPlaceholder) {
      const first = dispFirstLc ? dispFirst : 'there';
      msg = msg.replace(/\{name\}/gi, first).replace(/\{target\}/gi, first);

      // If we used placeholders, return without further rewriting or suffix-append.
      return twiml(res, msg);
    }

    // ✅ Otherwise, try the actor/target rewriter (for the normal “You…” phrasing)
    try {
      if (typeof rewriteWithActorTargetNames === 'function') {
        const rewritten = await rewriteWithActorTargetNames({
          ownerId,
          actorId,
          targetId: targetUserId,
          text: msg
        });

        if (rewritten && String(rewritten).trim()) {
          return twiml(res, String(rewritten).trim());
        }
      }
    } catch {}

    // ✅ Don’t suffix when message already clearly mentions the target (first name)
    // (Avoids: "✅ Logged clock in for Scott — Scott Jutras.")
    if (dispFirstLc && msgLc.includes(dispFirstLc)) {
      return twiml(res, msg);
    }

    // ✅ Avoid double-suffix when message already ends with the exact name
    const alreadyEndsWithName =
      msgLc.endsWith(`— ${dispLc}.`) ||
      msgLc.endsWith(`- ${dispLc}.`) ||
      msgLc.endsWith(`${dispLc}.`) ||
      msgLc.endsWith(`${dispLc}`);

    if (!alreadyEndsWithName) {
      msg = msg.replace(/\.$/, '');
      msg = `${msg} — ${disp}.`;
    }

    return twiml(res, msg);
  } catch {
    return twiml(res, msg);
  }
}


function normalizeSentencePunct(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : (t + '.');
}

// Build "You..." phrasing using the existing out.text
async function rewriteWithActorTargetNames({ ownerId, actorId, targetId, text }) {
  let msg = normalizeSentencePunct(text || 'Time logged.');

  const a = String(actorId || '').trim();
  const t = String(targetId || '').trim();
  if (!ownerId || !a || !t) return msg;

  // Resolve names (Crew works too)
  let targetName = t;
  try {
    targetName = await displayNameForUserId(ownerId, t);
  } catch {}

  // If the message already mentions "for ..." don't double-append
  if (/\sfor\s/i.test(msg)) return msg;

  // Self case: "You're <action> <Name>."
  if (a === t) {
    // Convert common passive confirmations into "You're ..."
    // Examples:
    // "✅ Clocked in." -> "✅ You're clocked in Scott."
    // "⏸️ Break started." -> "⏸️ You're on break Scott." (keeps your emoji)
    const m = msg.match(/^(\S+\s+)?(✅\s*)?(.*)$/); // keep emoji/leading bits
    const lead = (m?.[1] || '') + (m?.[2] || '');
    const core = (m?.[3] || msg).trim();

    // If core already starts with "You" or "You're", just append name
    if (/^(you|you're|you are)\b/i.test(core)) {
      return normalizeSentencePunct(`${lead}${core.replace(/\.$/, '')} ${targetName}`);
    }

    // Basic transform: lower-case first letter for "You're ..."
    // ✅ Special-case common segments so it reads naturally
const coreClean = core.replace(/\.$/, '').trim();
const coreNorm = coreClean.toLowerCase().replace(/\s+/g, ' ');

// Break
if (/^break (started|start)$/.test(coreNorm)) {
  return normalizeSentencePunct(`${lead}You're on break ${targetName}`);
}
if (/^break (stopped|stop|ended|end)$/.test(coreNorm)) {
  return normalizeSentencePunct(`${lead}You're back from break ${targetName}`);
}

// Lunch
if (/^lunch (started|start)$/.test(coreNorm)) {
  return normalizeSentencePunct(`${lead}You're at lunch ${targetName}`);
}
if (/^lunch (stopped|stop|ended|end)$/.test(coreNorm)) {
  return normalizeSentencePunct(`${lead}You're back from lunch ${targetName}`);
}

// Drive
if (/^drive (started|start)$/.test(coreNorm)) {
  return normalizeSentencePunct(`${lead}You're driving ${targetName}`);
}
if (/^drive (stopped|stop|ended|end)$/.test(coreNorm)) {
  return normalizeSentencePunct(`${lead}You're done driving ${targetName}`);
}

const coreLc = coreClean.charAt(0).toLowerCase() + coreClean.slice(1);

// If lead already includes "You're", don't add it again.
const leadHasYoure = /\byou['’]re\b/i.test(String(lead || ''));
const prefix = leadHasYoure ? String(lead || '') : `${String(lead || '')}You're `;

return normalizeSentencePunct(`${prefix}${coreLc} ${targetName}`);
  }

  // Target != actor: "You <action> <TargetName>."
  // If message already begins with emoji/✅, keep it.
  const m = msg.match(/^(\S+\s+)?(✅\s*)?(.*)$/);
  const lead = (m?.[1] || '') + (m?.[2] || '');
  const core = (m?.[3] || msg).trim();

  if (/^you\b/i.test(core)) {
    return normalizeSentencePunct(`${lead}${core.replace(/\.$/, '')} ${targetName}`);
  }

  // Convert passive into active-ish: "Clocked in." -> "You clocked in <Name>."
  const coreActive = core.charAt(0).toLowerCase() + core.slice(1);
  return normalizeSentencePunct(`${lead}You ${coreActive.replace(/\.$/, '')} ${targetName}`);
}


async function nameSuffix(ownerId, userId) {
  try {
    const name = await displayNameForUserId(ownerId, userId);
    if (!name) return '';
    return ` for ${name}`;
  } catch {
    return '';
  }
}

async function insertEntry(row) {
  const ownerId = String(row.owner_id || '').trim();
  const userId = String(row.user_id || '').trim();

  const createdBy = /^\d+$/.test(String(row.created_by || '').trim())
    ? String(row.created_by).trim()
    : null;

  const sourceMsgId = String(row.source_msg_id || '').trim() || null;

  const canUseMsgId = await hasTimeEntriesSourceMsgIdColumn();

  if (canUseMsgId) {
    const cols = [
      'owner_id',
      'user_id',
      'job_id',
      'parent_id',
      'kind',
      'start_at_utc',
      'end_at_utc',
      'meta',
      'created_by',
      'source_msg_id'
    ];
    const vals = cols.map((_, i) => `$${i + 1}`).join(',');
    const params = [
      ownerId,
      userId,
      row.job_id || null,
      row.parent_id || null,
      row.kind,
      row.start_at_utc,
      row.end_at_utc || null,
      row.meta || {},
      createdBy,
      sourceMsgId
    ];

    const { rows } = await pg.query(
      `INSERT INTO public.time_entries_v2 (${cols.join(',')})
       VALUES (${vals})
       ON CONFLICT (owner_id, user_id, source_msg_id) DO NOTHING
       RETURNING *`,
      params
    );
    return rows[0] || null;
  }

  // fallback (non-idempotent) — source_msg_id column absent; a Twilio retry will create a duplicate
  console.warn('[insertEntry] source_msg_id column missing — insert is NOT idempotent', { ownerId, userId, kind: row.kind });
  const cols = ['owner_id', 'user_id', 'job_id', 'parent_id', 'kind', 'start_at_utc', 'end_at_utc', 'meta', 'created_by'];
  const vals = cols.map((_, i) => `$${i + 1}`).join(',');
  const params = [
    ownerId,
    userId,
    row.job_id || null,
    row.parent_id || null,
    row.kind,
    row.start_at_utc,
    row.end_at_utc || null,
    row.meta || {},
    createdBy
  ];

  const { rows } = await pg.query(
    `INSERT INTO public.time_entries_v2 (${cols.join(',')})
     VALUES (${vals})
     RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function fetchPolicy(owner_id) {
  const ownerKey = String(owner_id || '').trim();
  if (!ownerKey) return {};

  try {
    // Try: JSON policy column (preferred)
    // If your table DOES have "policy" jsonb, this will work immediately.
    const { rows } = await pg.query(
      `select
         coalesce(policy, '{}'::jsonb) as policy,
         *
       from public.employer_policies
      where owner_id = $1
      limit 1`,
      [ownerKey]
    );

    const row = rows?.[0] || null;
    const policy = row?.policy && typeof row.policy === 'object' ? row.policy : {};

    // If policy json is present and has any expected keys, return it as-is.
    const hasNewKeys =
      policy &&
      (typeof policy.breaks_paid === 'boolean' ||
        typeof policy.lunch_paid === 'boolean' ||
        policy.auto_lunch_deduct_minutes != null ||
        typeof policy.drive_paid === 'boolean');

    if (hasNewKeys) return policy;

    // Otherwise: map legacy/column-based schema → new policy keys.
    // Your current defaults suggest you might have columns like:
    // paid_break_minutes, lunch_paid, paid_lunch_minutes, drive_is_paid
    const breaksPaid =
      typeof row?.breaks_paid === 'boolean'
        ? row.breaks_paid
        : // If you store "paid_break_minutes", treat >0 as paid breaks enabled
          (Number(row?.paid_break_minutes ?? 0) > 0 ? true : true); // default true

    const lunchPaid =
      typeof row?.lunch_paid === 'boolean'
        ? row.lunch_paid
        : true; // your previous fallback had lunch_paid:true; you can change this default if desired

    const autoLunchDeduct =
      Number.isFinite(Number(row?.auto_lunch_deduct_minutes))
        ? Number(row.auto_lunch_deduct_minutes)
        : // If lunch is unpaid and you had a "paid_lunch_minutes" concept, this is NOT the same.
          // If you want auto-deduct behavior, add a real column or store it in policy json.
          0;

    const drivePaid =
      typeof row?.drive_paid === 'boolean'
        ? row.drive_paid
        : typeof row?.drive_is_paid === 'boolean'
          ? row.drive_is_paid
          : true;

    return {
      breaks_paid: breaksPaid,
      lunch_paid: lunchPaid,
      auto_lunch_deduct_minutes: autoLunchDeduct,
      drive_paid: drivePaid
    };
  } catch (e) {
    console.warn('[POLICY] fetchPolicy failed (fail-open):', e?.message);
    return {};
  }
}



async function entriesForShift(owner_id, shift_id) {
  const { rows } = await pg.query(
    `SELECT id, parent_id, kind, start_at_utc, end_at_utc, meta, job_id
       FROM public.time_entries_v2
      WHERE owner_id = $1
        AND deleted_at IS NULL
        AND (id = $2 OR parent_id = $2)
      ORDER BY start_at_utc ASC`,
    [String(owner_id || '').trim(), shift_id]
  );
  return rows || [];
}


async function touchKPI(owner_id, job_id, day) {
  try {
    await pg.query(`INSERT INTO public.kpi_touches (owner_id, job_id, day) VALUES ($1,$2,$3)`, [
      String(owner_id || '').trim(),
      job_id,
      day
    ]);
  } catch {}
}

/* ---------------- Parsing helpers ---------------- */

function extractTargetName(lcOrText) {
  // Accept either already-lowercased text or raw text.
  const raw = String(lcOrText || '');

  // Remove trailing "@ job hint" (same behavior)
  const noJob = raw.replace(/\s*@\s*[^\n\r]+$/, '');

  // Normalize punctuation/spaces so "clock-out", "clock out", "clock_out" all match
  const norm = normalizeTcText(noJob);
  const s = norm.raw; // lower, punctuation->spaces, collapsed spaces

  // clock/punch variants
  let m = s.match(/^(?:clock|start|punch|punched)\s+in\s+(.+)$/i);
  if (!m) m = s.match(/^(?:clock|end|punch|punched)\s+out\s+(.+)$/i);

  // force variants (tolerant)
  if (!m) m = s.match(/^force\s+clock\s+in\s+(.+)$/i);
  if (!m) m = s.match(/^force\s+clock\s+out\s+(.+)$/i);

  return m ? String(m[1] || '').trim() : null;
}


function extractNarrative(text) {
  const m = String(text).match(
    /^([\p{L}\p{M}.'-]+(?:\s+[\p{L}\p{M}.'-]+){0,2})\s+(?:forgot|did\s*not|didn't|needs?|need)\s+to\s+clock\s+(in|out)\b/iu
  );
  if (!m) return null;
  return { name: m[1].trim(), action: m[2].toLowerCase() };
}

function extractSegmentNarrative(text) {
  const ordinal = '(?:second|2nd|third|3rd|fourth|4th|fifth|5th)?';
  const re = new RegExp(
    `^([\\p{L}\\p{M}.'-]+(?:\\s+[\\p{L}\\p{M}.'-]+){0,2})\\s+(?:forgot|did\\s*not|didn't|needs?|need)\\s+to\\s+(start|stop|end)\\s+(?:his|her|their|the)?\\s*(?:${ordinal}\\s*)?(break|drive)\\b`,
    'iu'
  );
  const m = String(text).match(re);
  if (!m) return null;
  const name = m[1].trim();
  const act = m[2].toLowerCase();
  const seg = m[3].toLowerCase();
  const action = act === 'end' || act === 'stop' ? 'stop' : 'start';
  return { name, seg, action };
}

function extractAtWhen(text) {
  const matches = [...String(text).matchAll(/\bat\s+([^.,;!?]+)(?:[.,;!?]|$)/gi)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1].trim();
}

function parseLocalWhenToIso(whenText, tz, refDate = new Date()) {
  if (!whenText) return null;
  const results = chrono.parse(whenText, refDate);
  if (!results.length) return null;
  const start = results[0].start;

  const refY = Number(formatInTimeZone(refDate, tz, 'yyyy'));
  const refM = Number(formatInTimeZone(refDate, tz, 'MM'));
  const refD = Number(formatInTimeZone(refDate, tz, 'dd'));

  const year = start.isCertain('year') ? start.get('year') : refY;
  const month = start.isCertain('month') ? start.get('month') : refM;
  const day = start.isCertain('day') ? start.get('day') : refD;
  const hour = start.isCertain('hour') ? start.get('hour') : 0;
  const minute = start.isCertain('minute') ? start.get('minute') : 0;
  const second = start.isCertain('second') ? start.get('second') : 0;

  const pad = (n) => String(n).padStart(2, '0');
  const localStamp = `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
  return zonedTimeToUtc(localStamp, tz).toISOString();
}

function formatLocal(ts, tz) {
  try {
    return new Date(ts).toLocaleString('en-CA', { timeZone: tz, hour12: false });
  } catch {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  }
}
async function emitTimeclockFact({
  ownerId,
  actorKey,
  sourceMsgId,
  resolvedType,

  // Backward/forward compatible target fields:
  targetKey,   // preferred: digits/employee key
  target,      // legacy: display name
  targetName,  // optional alias

  jobName,

  // Backward/forward compatible timestamps:
  occurredAtIso, // preferred
  tsIso          // legacy alias
}) {
  // NOTE: v2 (handleClock) emits facts internally.
  // This legacy emitter is quarantined for migration/debug only.
  if (!ALLOW_LEGACY_FACT_EMIT) return;

  try {
    const owner_id = String(ownerId || '').trim();
    const actor_key = String(actorKey || '').trim();
    const source_msg_id = sourceMsgId ? String(sourceMsgId).trim() : null;

    if (!owner_id || !actor_key) return;

    const type = String(resolvedType || '').trim() || 'unknown';
    const dedupe_key = `timeclock.logged:${String(source_msg_id || 'no_msg')}:${type}`;

    // Choose timestamp, guarantee ISO
    const rawAt = occurredAtIso || tsIso || null;
    const atIso =
      rawAt && !Number.isNaN(Date.parse(String(rawAt)))
        ? new Date(String(rawAt)).toISOString()
        : new Date().toISOString();

    // Choose target identity (prefer key, else name)
    const tKey = targetKey != null ? String(targetKey).trim() : null;
    const tName =
      (targetName != null ? String(targetName).trim() : null) ||
      (target != null ? String(target).trim() : null);

    await pg.insertFactEvent({
      owner_id,
      actor_key,

      event_type: 'timeclock.logged',
      entity_type: 'time_entry',
      entity_id: null,
      entity_no: null,

      job_id: null,
      job_no: null,
      job_name: jobName ? String(jobName).trim() : null,
      job_source: jobName ? 'active' : null,

      amount_cents: null,
      currency: null,

      occurred_at: atIso,
      source_msg_id,
      source_kind: 'whatsapp_text',

      event_payload: {
        type,
        target_key: tKey,
        target_name: tName,
        job_name: jobName ? String(jobName).trim() : null,
        at: atIso
      },

      dedupe_key
    });
  } catch (e) {
    console.warn('[FACT_EVENT] timeclock.logged insert failed (ignored):', e?.message);
  }
}



function normalizeTcText(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')  // punctuation -> spaces
    .replace(/\s+/g, ' ')
    .trim();

  return {
    raw: s,
    compact: s.replace(/\s+/g, '') // for breakstart/startbreak/onbreak/etc
  };
}

const _wordReCache = new Map();

function getWordRe(word) {
  const k = String(word || '').toLowerCase();
  let re = _wordReCache.get(k);
  if (!re) {
    re = mkWordRe(k);
    _wordReCache.set(k, re);
  }
  return re;
}

function hasAnyWord(normRaw, words) {
  const s = String(normRaw || '');
  return words.some(w => getWordRe(w).test(s));
}

function hasBoth(normRaw, a, b) {
  const s = String(normRaw || '');
  return getWordRe(a).test(s) && getWordRe(b).test(s);
}


function compactHasAny(compact, patterns) {
  return patterns.some(p => compact.includes(p));
}
function buildClockCilFromResolvedType(resolvedType, atIso) {
  const at = atIso && !Number.isNaN(Date.parse(String(atIso)))
    ? new Date(String(atIso)).toISOString()
    : new Date().toISOString();

  const map = {
    clock_in: 'in',
    clock_out: 'out',
    break_start: 'break_start',
    break_stop: 'break_stop',
    lunch_start: 'lunch_start',
    lunch_stop: 'lunch_stop',
    drive_start: 'drive_start',
    drive_stop: 'drive_stop'
  };

  const action = map[String(resolvedType || '').trim()] || null;
  if (!action) return null;

  return { type: 'Clock', action, at };
}


async function execClockViaCil({
  ownerId,
  paUserId,
  target,
  tz,
  stableMsgId,
  jobName,
  jobId = null,
  createdBy = null,
  resolvedType,
  tsOverride,
  nowIso,

  // MUST be effective plan already (status-aware)
  plan = 'free',

  role = 'owner',
  crew_count = 0,
  actorName = null
}) {
  const atIso = tsOverride || nowIso || new Date().toISOString();
  const cil = buildClockCilFromResolvedType(resolvedType, atIso);
  if (!cil) return null;

  const digitsOr = (v, fallback) => (/^\d+$/.test(String(v || '').trim()) ? String(v).trim() : fallback);

  const owner_id = String(ownerId || '').trim();
  const paDigits = String(paUserId || '').trim();
  const user_id = digitsOr(target, paDigits);
  const created_by = digitsOr(createdBy, paDigits);

  const actorNameClean = String(actorName || '').trim() || null;

  const ctx = {
    owner_id,
    user_id,
    tz: tz || 'America/Toronto',
    source_msg_id: stableMsgId || null,
    created_by,
    job_id: jobId || null,

    profileName: actorNameClean,

    meta: {
      job_name: jobName || null,
      actorName: actorNameClean,
      targetName: actorNameClean
    },

    // ✅ TRUST INPUT: plan already effective
    plan: String(plan || 'free').toLowerCase().trim(),
    role: String(role || 'owner').toLowerCase().trim(),
    crew_count: Number.isFinite(Number(crew_count)) ? Number(crew_count) : 0
  };

  return handleClock(ctx, cil);
}





// ----------------- Compact pattern dictionaries (module-scope) -----------------

const START_WORDS = ['start', 'starting', 'begin', 'on', 'going'];
const STOP_WORDS  = ['stop', 'end', 'off', 'finish', 'done'];

const CLOCK_IN_PATTERNS  = ['clockin', 'punchin', 'startshift', 'startmyday', 'shiftin'];
const CLOCK_OUT_PATTERNS = ['clockout', 'punchout', 'endshift', 'finishup', 'wrapup', 'shiftout'];

const BREAK_START_COMPACT = ['breakstart', 'startbreak', 'beginbreak', 'breakbegin', 'onbreak', 'breakon'];
const BREAK_STOP_COMPACT  = ['breakstop', 'stopbreak', 'endbreak', 'breakend', 'offbreak', 'breakoff'];

const DRIVE_START_COMPACT = ['drivestart', 'startdrive', 'begindrive', 'drivebegin', 'ondrive', 'driveon'];
const DRIVE_STOP_COMPACT  = ['drivestop', 'stopdrive', 'enddrive', 'driveend', 'offdrive', 'driveoff'];


// ----------------- Precompiled regexes (micro-optimization) -----------------
const RE_CLOCK_IN  = /\b(clock|punch)\s*in\b/i;
const RE_CLOCK_OUT = /\b(clock|punch)\s*out\b/i;
const RE_CLOCKIN_WORD  = /\b(clockin|punchin|shiftin)\b/i;
const RE_CLOCKOUT_WORD = /\b(clockout|punchout|shiftout)\b/i;
const RE_HAS_LUNCH = /\b(lunch)\b/i;
const RE_LUNCH_START = /^(?:lunch\s*(?:start|started|begin|began)|(?:start|begin|began)\s*lunch)$/i;
const RE_LUNCH_STOP  = /^(?:lunch\s*(?:stop|end|ended|finish|finished)|(?:stop|end|finish)\s*lunch)$/i;

const RE_HAS_BREAK = /\bbreak\b/i;
const RE_HAS_DRIVE = /\bdrive\b/i;

function mkWordRe(w) {
  return new RegExp(`\\b${w}\\b`, 'i');
}

/* ---------------- Legacy helpers (guarded by schema probe) ---------------- */

async function getCurrentState(ownerId, employeeName) {
  const shape = await detectTimeEntriesShape();

  if (shape === 'new') {
    const owner_id = String(ownerId || '').trim();

    // In new schema, user_id must be digits (or +E164 -> digits).
    const raw = String(employeeName || '').trim();
    const digits = raw.replace(/\D/g, '').trim();
    const user_id = /^\d+$/.test(digits) ? digits : null;

    if (!user_id) {
      console.warn('[timeclock] getCurrentState(new) called with non-user_id', {
        owner_id,
        raw: raw.slice(0, 60)
      });
      return { hasOpenShift: false, openBreak: false, openLunch: false, openDrive: false, lastShiftStart: null };
    }

    const openShift = await getOpenShift(owner_id, user_id);

    if (!openShift) {
      return { hasOpenShift: false, openBreak: false, openLunch: false, openDrive: false, lastShiftStart: null };
    }

    const { rows } = await pg.query(
      `SELECT kind, start_at_utc, end_at_utc
         FROM public.time_entries_v2
        WHERE owner_id=$1 AND parent_id=$2
        ORDER BY start_at_utc ASC`,
      [owner_id, openShift.id]
    );

    let openBreak = false;
    let openLunch = false;
    let openDrive = false;

    for (const r of rows || []) {
      const k = String(r.kind || '').toLowerCase();
      if (k === 'break' && !r.end_at_utc) openBreak = true;
      if (k === 'drive' && !r.end_at_utc) openDrive = true;
      if (k === 'lunch' && !r.end_at_utc) openLunch = true;
    }

    return { hasOpenShift: true, openBreak, openLunch, openDrive, lastShiftStart: openShift.start_at_utc };
  }


  if (shape === 'legacy') {
  const { rows } = await pg.query(
    `SELECT type, timestamp
       FROM public.time_entries
      WHERE owner_id = $1
        AND lower(employee_name) = lower($2)
      ORDER BY timestamp ASC
      LIMIT 200`,
    [String(ownerId || '').trim(), employeeName]
  );

    let hasOpenShift = false;
    let openBreak = false;
    let openLunch = false;
    let openDrive = false;
    let lastShiftStart = null;

    for (const r of rows || []) {
      const t = String(r.type || '').toLowerCase();

      switch (t) {
        case 'clock_in':
        case 'punch_in':
          hasOpenShift = true;
          lastShiftStart = r.timestamp;
          break;

        case 'clock_out':
        case 'punch_out':
          hasOpenShift = false;
          openBreak = false;
          openLunch = false;
          openDrive = false;
          lastShiftStart = null;
          break;

        case 'break_start':
          if (hasOpenShift) openBreak = true;
          break;

        case 'break_stop':
        case 'break_end':
          openBreak = false;
          break;

        case 'lunch_start':
          if (hasOpenShift) openLunch = true;
          break;

        case 'lunch_stop': // canonical
        case 'lunch_end':  // legacy alias (keep reading it)
          openLunch = false;
          break;

        case 'drive_start':
          if (hasOpenShift) openDrive = true;
          break;

        case 'drive_stop':
        case 'drive_end':
          openDrive = false;
          break;
      }
    }

    return { hasOpenShift, openBreak, openLunch, openDrive, lastShiftStart };
  }

  return { hasOpenShift: false, openBreak: false, openLunch: false, openDrive: false, lastShiftStart: null };
}
function parseDurationMinutes(s) {
  const raw0 = String(s || '').trim();
  const raw = raw0.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!raw) return null;

  // skip
  if (/^(skip|no|n)$/i.test(raw)) return { kind: 'skip' };

  // ----- helpers -----
  const WORD_NUM = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90
  };

  function wordToInt(w) {
    const k = String(w || '').toLowerCase().trim();
    if (!k) return null;
    if (k === 'a' || k === 'an') return 1;
    if (k in WORD_NUM) return WORD_NUM[k];

    // allow "twenty one", "twenty-one"
    const parts = k.replace(/-/g, ' ').split(' ').filter(Boolean);
    if (parts.length === 2 && parts[0] in WORD_NUM && parts[1] in WORD_NUM) {
      const a = WORD_NUM[parts[0]];
      const b = WORD_NUM[parts[1]];
      // only allow 20/30/.. + 1..9
      if (a >= 20 && a % 10 === 0 && b > 0 && b < 10) return a + b;
    }
    return null;
  }

  function clampMinutes(n) {
    if (!Number.isFinite(n)) return null;
    const m = Math.round(n);
    if (m <= 0) return null;
    // keep your sanity cap
    if (m > 360) return null;
    return m;
  }

  // ----- existing formats -----

  // 0:20 / 00:20
  const hhmm = raw.match(/^(\d{1,2})\s*:\s*(\d{1,2})$/);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const m = Number(hhmm[2]);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    const out = clampMinutes(h * 60 + m);
    if (!out) return null;
    return { kind: 'minutes', minutes: out };
  }

  // 20m / 20 min / 20mins / 20 minute(s)
  const m1 = raw.match(/^(\d{1,4})\s*(m|min|mins|minute|minutes)$/);
  if (m1) {
    const out = clampMinutes(Number(m1[1]));
    if (!out) return null;
    return { kind: 'minutes', minutes: out };
  }

  // plain number => minutes
  const plain = raw.match(/^(\d{1,4})$/);
  if (plain) {
    const out = clampMinutes(Number(plain[1]));
    if (!out) return null;
    return { kind: 'minutes', minutes: out };
  }

  // ----- NEW: compact hour/min tokens -----
  // "1h", "1h15m", "1h 15m"
  const hmCompact = raw.match(/^(\d{1,2})\s*h(?:\s*(\d{1,2})\s*m)?$/);
  if (hmCompact) {
    const h = Number(hmCompact[1]);
    const m = hmCompact[2] != null ? Number(hmCompact[2]) : 0;
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    const out = clampMinutes(h * 60 + m);
    if (!out) return null;
    return { kind: 'minutes', minutes: out };
  }

  // ----- NEW: strict "X hour(s) [Y minute(s)]" -----
  // e.g., "1 hour", "2 hours", "1 hour 15", "1 hour 15 minutes"
  const hourMin = raw.match(
    /^(\d{1,2})\s*(h|hr|hrs|hour|hours)(?:\s+(\d{1,2})\s*(m|min|mins|minute|minutes)?)?$/
  );
  if (hourMin) {
    const h = Number(hourMin[1]);
    const m = hourMin[3] != null ? Number(hourMin[3]) : 0;
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    const out = clampMinutes(h * 60 + m);
    if (!out) return null;
    return { kind: 'minutes', minutes: out };
  }

  // ----- NEW: word-number minutes -----
  // "ten minutes", "one min", "a minute"
  const wordMin = raw.match(/^([a-z-]+)\s*(m|min|mins|minute|minutes)$/);
  if (wordMin) {
    const n = wordToInt(wordMin[1]);
    if (n == null) return null;
    const out = clampMinutes(n);
    if (!out) return null;
    return { kind: 'minutes', minutes: out };
  }

  // ----- NEW: word-number hours (optionally + minutes) -----
  // "an hour", "two hours", "two hours fifteen minutes"
  const wordHour = raw.match(
    /^([a-z-]+)\s*(h|hr|hrs|hour|hours)(?:\s+([a-z-]+|\d{1,2})\s*(m|min|mins|minute|minutes)?)?$/
  );
  if (wordHour) {
    const h = wordToInt(wordHour[1]);
    if (h == null) return null;

    let m = 0;
    if (wordHour[3] != null) {
      if (/^\d{1,2}$/.test(String(wordHour[3]))) m = Number(wordHour[3]);
      else {
        const mw = wordToInt(wordHour[3]);
        if (mw == null) return null;
        m = mw;
      }
    }

    const out = clampMinutes(h * 60 + m);
    if (!out) return null;
    return { kind: 'minutes', minutes: out };
  }

  // ----- NEW: "half hour" variants -----
  if (/^(half\s*(an?\s*)?(h|hr|hour))$/.test(raw) || /^(a\s*half\s*(an?\s*)?(h|hr|hour))$/.test(raw)) {
    return { kind: 'minutes', minutes: 30 };
  }

  return null;
}


async function handleSegmentDurationRepairReply(ctx, text) {
  const owner_id = String(ctx?.owner_id || '').trim();
  const user_id = String(ctx?.user_id || '').trim();
  const source_msg_id = ctx?.source_msg_id ? String(ctx.source_msg_id).trim() : null;
  const tz = ctx?.tz || 'UTC';

  const ret = (msg) => ({ text: String(msg || '').trim(), targetUserId: user_id || null });

  if (!owner_id || !user_id) return ret('Timeclock: missing owner_id or user_id.');

  // quick gate: don't hijack random texts
const looksDurationOrSkip =
  /^\s*(skip|no|n|(\d{1,4}\s*(m|min|mins|minute|minutes)?)|(\d{1,2}\s*:\s*\d{1,2})|([a-z-]+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours))|(half\s*(an?\s*)?(h|hr|hour))|(a\s*half\s*(an?\s*)?(h|hr|hour)))\s*$/i
    .test(String(text || ''));

  if (!looksDurationOrSkip) return null;

  // Find active prompt (most recent, unexpired)
  const { rows } = await pg.query(
    `SELECT *
       FROM public.timeclock_repair_prompts
      WHERE owner_id=$1
        AND user_id=$2
        AND kind='segment_duration'
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC
      LIMIT 1`,
    [owner_id, user_id]
  );
  const prompt = rows?.[0] || null;
  if (!prompt) return null;

  const parsed = parseDurationMinutes(text);
  if (!parsed) return ret('Sorry — reply like “20 min” or “skip”.');

  if (parsed.kind === 'skip') {
    await pg.query(`DELETE FROM public.timeclock_repair_prompts WHERE id=$1`, [prompt.id]);
    return ret('👍 Okay — leaving it ended where I stopped it.');
  }

  const minutesReq = Number(parsed.minutes || 0);
  if (!Number.isFinite(minutesReq) || minutesReq <= 0) return ret('Sorry — reply like “20 min” or “skip”.');
  if (minutesReq > 360) return ret('That length looks too long. Reply like “20 min” or “skip”.');

  // Load entry start so we can do: end = start + minutes
  const e = await pg.query(
    `SELECT id, kind, start_at_utc
       FROM public.time_entries_v2
      WHERE owner_id=$1
        AND id=$2::bigint
        AND deleted_at IS NULL
      LIMIT 1`,
    [owner_id, prompt.entry_id]
  );

  const entry = e?.rows?.[0] || null;
  if (!entry?.start_at_utc) {
    await pg.query(`DELETE FROM public.timeclock_repair_prompts WHERE id=$1`, [prompt.id]);
    return ret('Okay — I couldn’t adjust that (entry not found).');
  }

  const start = new Date(entry.start_at_utc);

  // endedAt from prompt, fallback to "now" (fail-soft)
  const endedAtIso = prompt.ended_at_utc ? new Date(prompt.ended_at_utc).toISOString() : new Date().toISOString();
  const endedAt = new Date(endedAtIso);

  // Requested end = start + requested minutes
  const requestedEnd = new Date(start.getTime() + minutesReq * 60 * 1000);

  // Clamp so we never extend past where we auto-ended
  const appliedEnd = requestedEnd > endedAt ? endedAt : requestedEnd;

  const minutesApplied = Math.max(0, Math.round((appliedEnd.getTime() - start.getTime()) / 60000));

  const segKind = String(prompt.segment_kind || entry.kind || '').trim() || 'break';

  const r = await pg.query(
    `UPDATE public.time_entries_v2
        SET end_at_utc = $3::timestamptz,
            updated_at = now(),
            meta = jsonb_set(
              coalesce(meta,'{}'::jsonb),
              '{repair}',
              jsonb_build_object(
                'kind','segment_duration',
                'segment_kind',$4::text,
                'minutes_requested',$5::int,
                'minutes_applied',$6::int,
                'ended_at_utc',$7::timestamptz,
                'applied_end_at_utc',$3::timestamptz,
                'source_msg_id',$8::text
              ),
              true
            )
      WHERE owner_id=$1
        AND id=$2::bigint
        AND deleted_at IS NULL
      RETURNING id`,
    [
      owner_id,
      prompt.entry_id,
      appliedEnd.toISOString(),
      segKind,
      minutesReq,
      minutesApplied,
      endedAtIso,
      source_msg_id
    ]
  );

  // Clear prompt regardless (fail-soft)
  await pg.query(`DELETE FROM public.timeclock_repair_prompts WHERE id=$1`, [prompt.id]);

  if (!r?.rows?.length) return ret('Okay — I couldn’t adjust that (it may have already been edited).');

  const segLabel =
  segKind === 'lunch' ? 'lunch' :
  segKind === 'drive' ? 'drive' : 'break';

// Optional: personalize with first name if available
const firstName = String(ctx?.fallbackName || '').trim().split(/\s+/)[0] || '';
const who = firstName ? `, ${firstName}` : '';

return ret(`✅ You got it${who}. I set your ${segLabel} to ${minutesApplied} min (ended at ${toHumanTime(appliedEnd.toISOString(), tz)}).`);
}



/* ---------------- CIL handler (new schema path) ---------------- */

async function handleClock(ctx, cil) {
  // --- identity / return helper (must exist before any early returns) ---
  const owner_id = String(ctx?.owner_id || '').trim();
  const user_id = String(ctx?.user_id || '').trim();
  const targetUserId = user_id || null;

  // allow future extra fields without refactoring again
  const ret = (text, extra = {}) => ({ text: String(text || '').trim(), targetUserId, ...extra });

 if (!owner_id || !user_id) return ret("Timeclock: missing owner_id or user_id.");

const plan = String(ctx?.plan || "free").toLowerCase().trim();



const rawRole = String(ctx?.role || "owner").toLowerCase().trim();
const role =
  rawRole === "board_member" ? "board" :
  rawRole === "crew_member" ? "crew" :
  rawRole === "employee" ? "crew" :          // ✅ map employee → crew
  rawRole === "crew" ? "crew" :
  rawRole === "board" ? "board" :
  rawRole === "owner" ? "owner" :
  "owner"; // fail-safe

const gate = canLogTime(plan, role);
if (!gate.allowed) {
  // ✅ GTM gold: record denial for analytics (fail-open)
  try {
    await logCapabilityDenial(pg, {
      owner_id,
      user_id: user_id || null,
      actor_role: role || null,
      plan: plan || null,
      capability: "timeclock",
      reason_code: gate.reason_code,
      upgrade_plan: gate.upgrade_plan || null,
      job_id: ctx?.job_id || null,
      source_msg_id: ctx?.source_msg_id || null,
      context: {
        handler: "timeclock.handleClock",
        role_raw: ctx?.role || null,
        plan_raw: ctx?.plan || null,
      },
    });
  } catch {}

    // ✅ Moment 2: only once, Free/Starter, crew-adjacent implication
  // We treat "role !== owner" attempting to log time as a valid "crew exists" signal.
  let moment2 = null;
  try {
    moment2 = await maybeGetCrewMomentText({
      pg,
      ownerId: owner_id,
      userId: user_id,
      role,
      plan,
      context: {
        source_msg_id: ctx?.source_msg_id || null,
        handler: "timeclock.handleClock",
        trigger: "time_log_attempt_denied",
        role_raw: ctx?.role || null,
        plan_raw: ctx?.plan || null,
      },
      includeFollowUp: false, // set true if you want “Want me to send the upgrade link?”
    });
  } catch {}

  const msg = moment2 ? `${gate.message}\n\n${moment2}` : gate.message;

  return ret(msg, {
    reason_code: gate.reason_code,
    upgrade_plan: gate.upgrade_plan,
  });
}




  if (!ClockCIL) {
    return ret('Timeclock: CIL schema missing. Please update schemas/cil.clock.');
  }

  // --- parse / timestamps ---
  let parsed;
  try {
    parsed = ClockCIL.parse(cil); // throws on invalid
  } catch (e) {
    return ret('Timeclock: invalid command.');
  }

  const nowIso = new Date().toISOString();
  const atRaw = parsed.at || nowIso;

  const occurredAtIso =
    atRaw && !Number.isNaN(Date.parse(String(atRaw)))
      ? new Date(String(atRaw)).toISOString()
      : new Date().toISOString();

  const job_id = ctx.job_id || null;

  const created_by_raw = ctx.created_by || null;
  const created_by = /^\d+$/.test(String(created_by_raw || '').trim())
    ? String(created_by_raw).trim()
    : (user_id || null);

  const source_msg_id = ctx.source_msg_id ? String(ctx.source_msg_id).trim() : null;
  const tz = ctx.tz || 'UTC';
  console.info('[TIME_V2_TZ]', { owner_id, user_id, tz });


  // ---------------- helpers ----------------

  async function emit(payload, dedupeSuffix, entity_id = null, jobId = null) {
    try {
      await pg.insertFactEvent({
        owner_id,
        actor_key: user_id,

        event_type: 'timeclock.logged',
        entity_type: 'time_entry',
        entity_id: entity_id != null ? String(entity_id) : null,
        entity_no: null,

        job_id: jobId || null,

        occurred_at: occurredAtIso,
        source_msg_id,
        source_kind: 'whatsapp_text',

        event_payload: payload,

        dedupe_key: `timeclock.logged:${String(source_msg_id || 'no_msg')}:${dedupeSuffix}`
      });
    } catch (e) {
      console.warn('[FACT_EVENT] timeclock.logged insert failed (ignored):', e?.message);
    }
  }

  async function requireOpenShift() {
    const shift = await getOpenShift(owner_id, user_id);
    if (!shift) return { shift: null, errText: `You’re not clocked in.` };
    return { shift, errText: null };
  }

async function getActiveRepairPrompt(kind = 'break_duration') {
  const { rows } = await pg.query(
    `SELECT *
       FROM public.timeclock_repair_prompts
      WHERE owner_id=$1
        AND user_id=$2
        AND kind=$3
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC
      LIMIT 1`,
    [owner_id, user_id, kind]
  );
  return rows?.[0] || null;
}

async function clearRepairPrompt(id) {
  if (!id) return;
  try {
    await pg.query(`DELETE FROM public.timeclock_repair_prompts WHERE id=$1`, [id]);
  } catch {}
}

  // ---------------- actions ----------------

  if (parsed.action === 'in') {
    const open = await getOpenShift(owner_id, user_id);
    if (open) {
  const who =
    String(ctx?.meta?.targetName || ctx?.meta?.actorName || ctx?.meta?.name || '').trim() ||
    String(ctx?.profileName || '').trim() ||
    'there';

  const dt = new Date(open.start_at_utc);
  const timeLine = (() => {
    try { return formatInTimeZone(dt, tz, 'h:mmaaa').replace('AM', 'am').replace('PM', 'pm'); }
    catch { return formatLocal(open.start_at_utc, tz); }
  })();

  const dateLine = (() => {
    try { return formatInTimeZone(dt, tz, 'EEEE, MMMM do, yyyy'); }
    catch { return ''; }
  })();

  return ret(
    `One moment, ${who}.\n` +
    `It looks like you’ve been clocked in since:\n` +
    `${timeLine}\n` +
    `${dateLine ? dateLine : ''}`.trim()
  );
}


    const inserted = await insertEntry({
      owner_id,
      user_id,
      job_id,
      parent_id: null,
      kind: 'shift',
      start_at_utc: atRaw,
      end_at_utc: null,
      created_by,
      meta: ctx.meta || {},
      source_msg_id
    });

    if (inserted) {
      await emit(
        { action: 'in', kind: 'shift', at: occurredAtIso, shift_id: inserted.id ?? null },
        'clock_in',
        inserted.id ?? null,
        job_id || null
      );

      // Schedule lunch reminder (non-fatal)
      try {
        const { createLunchReminder } = require('../../services/reminders');
        // Noon local today; if already past noon, fallback to 4h from now
        const noon = new Date();
        noon.setHours(12, 0, 0, 0);
        const remindAt = noon > new Date() ? noon : new Date(Date.now() + 4 * 60 * 60 * 1000);
        await createLunchReminder({
          ownerId: owner_id,
          userId: user_id,
          shiftId: String(inserted.id ?? ''),
          remindAt,
          sourceMsgId: source_msg_id ? `lunch:${source_msg_id}` : null,
        });
      } catch (e) {
        console.warn('[REMINDERS] createLunchReminder failed (ignored):', e?.message);
      }
    }

    return ret(`✅ Clocked in at ${toHumanTime(occurredAtIso, tz)}.`);
  }

 if (parsed.action === 'out') {
  const { shift, errText } = await requireOpenShift();
  if (!shift) return ret(errText);

  // detect any open segment (break/lunch/drive) BEFORE we auto-close children
  const { rows: openSegRows } = await pg.query(
    `SELECT id, kind
       FROM public.time_entries_v2
      WHERE owner_id=$1
        AND parent_id=$2
        AND kind IN ('break','lunch','drive')
        AND end_at_utc IS NULL
        AND deleted_at IS NULL
      ORDER BY start_at_utc DESC
      LIMIT 1`,
    [owner_id, shift.id]
  );

  const openSeg = openSegRows?.[0] || null;
  const openSegId = openSeg?.id || null;
  const openSegKind = String(openSeg?.kind || '').trim() || null;

  console.info('[TIME_V2_OUT_OPEN_SEGMENT]', {
    shiftId: shift.id,
    openSegId: openSegId || null,
    openSegKind: openSegKind || null
  });

  // close any open children (including break/lunch/drive) at clock-out time
  await pg.query(
    `UPDATE public.time_entries_v2
        SET end_at_utc=$3,
            updated_at=now()
      WHERE owner_id=$1
        AND parent_id=$2
        AND end_at_utc IS NULL
        AND deleted_at IS NULL`,
    [owner_id, shift.id, atRaw]
  );

  // close the shift
  await closeEntryById(owner_id, shift.id, atRaw);

  // --- calc + store calc in meta ---
  const policy = await fetchPolicy(owner_id);
  const entries = await entriesForShift(owner_id, shift.id);

  let calc = { paidMinutes: 0, unpaidLunch: 0, unpaidBreak: 0 };
  try {
    // eslint-disable-next-line global-require
    const { computeShiftCalc } = require('../../services/timecalc');
    calc = computeShiftCalc(entries, policy) || calc;
  } catch {}

  try {
    await pg.query(
      `UPDATE public.time_entries_v2
          SET meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{calc}', $3::jsonb),
              updated_at=now()
        WHERE id=$1 AND owner_id=$2`,
      [shift.id, owner_id, JSON.stringify(calc)]
    );
  } catch {}

  // KPI touch + fact event
  try {
    const day = new Date(shift.start_at_utc).toISOString().slice(0, 10);
    await touchKPI(owner_id, shift.job_id, day);
  } catch {}

  try {
    await emit(
      { action: 'out', kind: 'shift', at: occurredAtIso, shift_id: shift.id, calc },
      'clock_out',
      shift.id,
      shift.job_id || null
    );
  } catch {}

  // ---------------- Timesheet Truth summary ----------------
const shiftMinutes = Number(calc?.shiftMinutes ?? 0);
const breakTotal = Number(calc?.breakTotal ?? 0);
const lunchTotal = Number(calc?.lunchTotal ?? 0);
const driveTotal = Number(calc?.driveTotal ?? 0);

const unpaidLunch = Number(calc?.unpaidLunch ?? 0);
const unpaidBreak = Number(calc?.unpaidBreak ?? 0);

// Work time = what actually happened (truth, not policy)
const workMinutes = Math.max(0, shiftMinutes - breakTotal - lunchTotal);

// Paid time = policy result (can differ from truth)
const paidMinutes = Number(calc?.paidMinutes ?? workMinutes);

// formatter
const hm = (mins) => {
  const m = Math.max(0, Number(mins) || 0);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
};

// policy note line (only when policy changes paid)
let policyNote = '';
if (paidMinutes !== workMinutes) {
  const bits = [];
  if (unpaidLunch > 0) bits.push(`lunch ${unpaidLunch}m`);
  if (unpaidBreak > 0) bits.push(`breaks ${unpaidBreak}m`);
  policyNote = bits.length ? `Policy deducted: ${bits.join(', ')}.` : 'Policy adjusted paid time.';
}

// WhatsApp-friendly multi-line summary
const truthLines = [
  `⏱️ Shift: ${hm(shiftMinutes)}`,
  `☕ Breaks: ${hm(breakTotal)}`,
  `🥪 Lunch: ${hm(lunchTotal)}`,
  `🚗 Drive: ${hm(driveTotal)} (tracked, not deducted)`,
  ``,
  `🧱 Work time (Shift − Break − Lunch): ${hm(workMinutes)}`,
  `💵 Paid time: ${hm(paidMinutes)}`
];

if (policyNote) truthLines.push(``, `ℹ️ ${policyNote}`);

let finalText = `✅ Clocked out.\n${truthLines.join('\n')}`;


  // If a segment was open at clock-out, create repair prompt + use kind-specific copy
  if (openSegId && openSegKind) {
    try {
      await pg.query(
        `INSERT INTO public.timeclock_repair_prompts
          (owner_id, user_id, kind, shift_id, entry_id, segment_kind, ended_at_utc, ended_reason, expires_at, source_msg_id)
         VALUES
          ($1,$2,'segment_duration',$3,$4,$5,$6,'clock_out', now() + interval '12 hours', $7)`,
        [
          owner_id,
          user_id,
          shift.id,
          openSegId,
          openSegKind,
          occurredAtIso,
          source_msg_id
        ]
      );

      // ✅ SUCCESS LOG GOES IMMEDIATELY AFTER INSERT SUCCEEDS (RIGHT HERE)
      console.info('[TIME_V2_REPAIR_PROMPT_INSERTED]', {
        owner_id,
        user_id,
        shiftId: shift.id,
        entryId: openSegId,
        segment: openSegKind,
        occurredAtIso,
        source_msg_id
      });

      const label = openSegKind === 'lunch' ? 'lunch' : openSegKind === 'drive' ? 'drive' : 'break';

      finalText =
  `✅ Clocked out.\n` +
  `${truthLines.join('\n')}\n\n` +
  `Your ${label} was still running — I ended it at clock-out.\n` +
  `How long was your ${label}? (e.g., “20 min”) or reply “skip”.`;
    } catch (e) {
      console.warn('[REPAIR_PROMPT] insert failed (ignored):', e?.message);
    }
  }

  return ret(finalText);
}



 // Segment START (break/lunch/drive)
if (parsed.action === 'break_start' || parsed.action === 'lunch_start' || parsed.action === 'drive_start') {
  const { shift, errText } = await requireOpenShift();
  if (!shift) return ret(errText);

  const kind = parsed.action.split('_')[0]; // break | lunch | drive

  // If another segment is open, close it at THIS segment start time and create a repair prompt for it
  const { rows: openAnyRows } = await pg.query(
    `SELECT id, kind, start_at_utc
       FROM public.time_entries_v2
      WHERE owner_id=$1
        AND parent_id=$2
        AND kind IN ('break','lunch','drive')
        AND end_at_utc IS NULL
        AND deleted_at IS NULL
      ORDER BY start_at_utc DESC
      LIMIT 1`,
    [owner_id, shift.id]
  );

  const openAny = openAnyRows?.[0] || null;

  let repairTail = '';

  if (openAny && String(openAny.kind) !== String(kind)) {
    const prevKind = String(openAny.kind);

    // auto-end previous segment at this moment
    await pg.query(
      `UPDATE public.time_entries_v2
          SET end_at_utc=$3, updated_at=now()
        WHERE owner_id=$1 AND id=$2::bigint`,
      [owner_id, openAny.id, atRaw]
    );

    // create repair prompt for the segment we just ended
    try {
      await pg.query(
        `INSERT INTO public.timeclock_repair_prompts
          (owner_id, user_id, kind, shift_id, entry_id, segment_kind, ended_at_utc, ended_reason, expires_at, source_msg_id)
         VALUES
          ($1,$2,'segment_duration',$3,$4,$5,$6,$7, now() + interval '12 hours', $8)`,
        [
          owner_id,
          user_id,
          shift.id,
          openAny.id,
          prevKind,
          occurredAtIso,
          `switch_to_${kind}`,
          source_msg_id
        ]
      );

      // success log (helps debugging segment switches)
      console.info('[TIME_V2_REPAIR_PROMPT_INSERTED]', {
        owner_id,
        user_id,
        shiftId: shift.id,
        entryId: openAny.id,
        segment: prevKind,
        endedAtUtc: occurredAtIso,
        reason: `switch_to_${kind}`,
        source_msg_id
      });

      const label = prevKind === 'lunch' ? 'lunch' : prevKind === 'drive' ? 'drive' : 'break';
      repairTail =
        `Your ${label} was still running — I ended it at ${kind} start.\n` +
        `How long was your ${label}? (e.g., “20 min”) or reply “skip”.`;
    } catch (e) {
      console.warn('[REPAIR_PROMPT] insert failed (ignored):', e?.message);
      // fail-soft: still proceed starting the new segment
    }
  }

  // If same kind already open, don't create a new one
  const { rows: openKids } = await pg.query(
    `SELECT id, start_at_utc
       FROM public.time_entries_v2
      WHERE owner_id=$1
        AND parent_id=$2
        AND kind=$3
        AND end_at_utc IS NULL
        AND deleted_at IS NULL
      ORDER BY start_at_utc DESC
      LIMIT 1`,
    [owner_id, shift.id, kind]
  );

  const openKid = openKids?.[0] || null;
  if (openKid) {
    const label = kind === 'lunch' ? '🍽️ Lunch' : kind === 'break' ? '⏸️ Break' : '🚚 Drive';
    return ret(`${label} already started at ${formatLocal(openKid.start_at_utc, tz)}.`);
  }

  // Create the new segment entry
  const inserted = await insertEntry({
    owner_id,
    user_id,
    job_id: shift.job_id || null,
    parent_id: shift.id,
    kind,
    start_at_utc: atRaw,
    end_at_utc: null,
    created_by,
    meta: ctx.meta || {},
    source_msg_id
  });

  if (inserted) {
    await emit(
      { action: 'start', kind, at: occurredAtIso, shift_id: shift.id, child_id: inserted.id ?? null },
      `${kind}_start`,
      inserted.id ?? null,
      shift.job_id || null
    );
  }

  const startedLine = kind === 'lunch' ? `🍽️ Lunch started.` : kind === 'break' ? `⏸️ Break started.` : `🚚 Drive started.`;

  // If we had to auto-close another segment, append the repair question as extra lines
  return ret(repairTail ? `${startedLine}\n${repairTail}` : startedLine);
}



  // Segment STOP (break/lunch/drive)
  if (parsed.action === 'break_stop' || parsed.action === 'lunch_stop' || parsed.action === 'drive_stop') {
    const { shift, errText } = await requireOpenShift();
    if (!shift) return ret(errText);

    const kind = parsed.action.split('_')[0]; // break | lunch | drive

    const r = await pg.query(
      `UPDATE public.time_entries_v2
          SET end_at_utc=$3, updated_at=now()
        WHERE owner_id=$1 AND parent_id=$2 AND kind=$4 AND end_at_utc IS NULL
        RETURNING id`,
      [owner_id, shift.id, atRaw, kind]
    );

    const childId = r?.rows?.[0]?.id ?? null;

    if (!childId) {
      if (kind === 'lunch') return ret(`No active lunch to stop.`);
      if (kind === 'break') return ret(`No active break to stop.`);
      return ret(`No active drive to stop.`);
    }

    await emit(
      { action: 'stop', kind, at: occurredAtIso, shift_id: shift.id, child_id: childId },
      `${kind}_stop`,
      childId,
      shift.job_id || null
    );

    if (kind === 'lunch') return ret(`🍽️ Lunch stopped.`);
    if (kind === 'break') return ret(`▶️ Break ended.`);
    return ret(`🅿️ Drive stopped.`);
  }
return ret('Timeclock: action not recognized.');

}


/* ---------------- Legacy text command wrapper (PARSE OK, LEGACY WRITE FORBIDDEN) ---------------- */

async function handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId = null) {
  const tz = userProfile?.tz || userProfile?.timezone || 'America/Toronto';
  const now = new Date();
  const actorName =
  String(userProfile?.name || userProfile?.ProfileName || '').trim() ||
  'there';

  const reqBody = res?.req?.body || {};
  const paUserId = getPaUserId(from, userProfile, reqBody); // ✅ digits

  const stableMsgId =
    String(reqBody?.MessageSid || reqBody?.SmsMessageSid || '').trim() ||
    String(sourceMsgId || '').trim() ||
    String(getTwilioMessageSidFromRes(res) || '').trim() ||
    null;

// ✅ Canonical, status-aware plan
const plan = getEffectivePlanFromOwner(ownerProfile);




// ✅ Role: if this inbound user is the owner → owner, otherwise treat as crew.
// (If you later distinguish “employee self logging” vs “owner logging for crew”, you can refine this.)
// Phase 1: anyone who is not the owner is treated as "employee self-log attempt"
const role = isOwner ? "owner" : "employee";


// optional for now
const crew_count = 0;

  const lc = String(text || '').toLowerCase().trim();
// ✅ Optional early Gate #1 (cheap reject; handleClock still enforces)
try {
  if (!isOwner) {
    const isPro = plan === 'pro' || plan === 'enterprise';

    const looksLikeTimeLog =
      /\b(clock|punch)\s+(in|out)\b/.test(lc) ||
      /\b(break|lunch)\s+(start|stop|end)\b/.test(lc) ||
      /\bdrive\s+(start|stop|end)\b/.test(lc) ||
      /\b(start|end)\s+(shift|work)\b/.test(lc);

    if (looksLikeTimeLog && !isPro) {
      return twiml(
        res,
        `⛔ Crew self-logging is Pro only.\n\nThe owner can still log your time from their phone.\n\nUpgrade to Pro to let employees clock in/out from their own phones.`
      );
    }
  }
} catch (e) {
  console.warn('[TIMELOCK_GATE] failed (fail-open):', e?.message);
}

  try {
    // Help
    if (lc === 'timeclock' || lc === 'help timeclock') {
      return twiml(
        res,
        `Timeclock — Quick guide:
• clock in / clock out (or punch in/out)
• break start / break stop
• lunch start / lunch stop
• drive start / drive stop
• undo last
• timesheet week
Tip: add @ Job Name for context (e.g., “clock in @ Roof Repair”).`
      );
    }

    // ✅ Timesheet is handled by the v2 gate + handleTimesheetCommand (NOT here)
    if (/^timesheet\b/i.test(String(text || '').trim())) return false;

    // Rate limit (fail-open)
    try {
      if (typeof pg.checkTimeEntryLimit === 'function') {
        const limit = await pg.checkTimeEntryLimit(ownerId, paUserId, { max: 8, windowSec: 30 });
        if (limit && limit.ok === false) return twiml(res, 'Too many actions — slow down for a few seconds.');
      }
    } catch {}

    // ---------------- intent detection ----------------
const norm = normalizeTcText(text);
const rawNorm = norm.raw;
const compact = norm.compact;

const isUndo = /^undo(\s+last)?$/i.test(rawNorm) || /^undo(last)?$/i.test(compact);

const looksLikeTimeclock =
  isUndo ||
  /\b(time\s*clock|timeclock|clock|punch|break|drive|hours|lunch|undo)\b/.test(rawNorm) ||
  /\b(clockin|clockout|punchin|punchout|shiftin|shiftout|undolast|breakstart|breakend|startbreak|lunchstart|lunchend)\b/.test(compact);

if (!looksLikeTimeclock) return false;

// ✅ HARD STOP: v2 requires new schema
const shape = await detectTimeEntriesShape();
if (shape !== 'new') {
  return twiml(
    res,
    `⛔ Timeclock v2 is not ready on this database yet.
Your time_entries table is still LEGACY (employee_name/type/timestamp).
Run the v2 migration (kind/start_at_utc/end_at_utc + idempotency) or turn off flags.timeclock_v2.

Detected: ${shape}`
  );
}

// Job hint
const explicitJobName = extractJobHint(text) || null;
const jobName = await resolveJobNameForActor({ ownerId, identityKey: paUserId, explicitJobName });

// Target (actor only for now)
const targetUserId = String(paUserId || '').trim();
if (!targetUserId) return twiml(res, 'Timeclock: missing identity.');

// When override
const whenTxt = extractAtWhen(text);
const tsOverrideIso = whenTxt ? parseLocalWhenToIso(whenTxt, tz, now) : null;

// Resolve type using your existing mapping
const resolvedType =
  (RE_CLOCK_IN.test(rawNorm) || RE_CLOCKIN_WORD.test(rawNorm) || compactHasAny(compact, CLOCK_IN_PATTERNS)) ? 'clock_in'
  : (RE_CLOCK_OUT.test(rawNorm) || RE_CLOCKOUT_WORD.test(rawNorm) || compactHasAny(compact, CLOCK_OUT_PATTERNS)) ? 'clock_out'
  : (RE_HAS_BREAK.test(rawNorm) && (compactHasAny(compact, BREAK_START_COMPACT) || /\bbreak\s*start(ed)?\b/i.test(rawNorm))) ? 'break_start'
  : (RE_HAS_BREAK.test(rawNorm) && (compactHasAny(compact, BREAK_STOP_COMPACT)  || /\bbreak\s*(stop|end)(ed)?\b/i.test(rawNorm))) ? 'break_stop'
  : (RE_HAS_LUNCH.test(rawNorm) && (RE_LUNCH_START.test(rawNorm) || compact === 'lunchstart' || compact === 'startlunch')) ? 'lunch_start'
  : (RE_HAS_LUNCH.test(rawNorm) && (RE_LUNCH_STOP.test(rawNorm)  || compact === 'lunchend'  || compact === 'endlunch' || compact === 'lunchstop' || compact === 'stoplunch')) ? 'lunch_stop'
  : (RE_HAS_DRIVE.test(rawNorm) && (compactHasAny(compact, DRIVE_START_COMPACT) || /\bdrive\s*start(ed)?\b/i.test(rawNorm))) ? 'drive_start'
  : (RE_HAS_DRIVE.test(rawNorm) && (compactHasAny(compact, DRIVE_STOP_COMPACT)  || /\bdrive\s*(stop|end)(ed)?\b/i.test(rawNorm))) ? 'drive_stop'
  : null;

// If ambiguous segment intent, quick reply
if (!resolvedType && !isUndo) {
  const hasBreak = RE_HAS_BREAK.test(rawNorm);
  const hasDrive = RE_HAS_DRIVE.test(rawNorm);
  const hasLunch = RE_HAS_LUNCH.test(rawNorm);

  if (hasBreak || hasDrive || hasLunch) {
    const seg = hasBreak ? 'Break' : (hasLunch ? 'Lunch' : 'Drive');
    try {
      await sendQuickReply(
        from,
        `Do you want me to ${seg.toLowerCase()} **start** or **stop**?${
          tsOverrideIso ? ' at ' + formatLocal(tsOverrideIso, tz) : ''
        }\nReply: "${seg} Start" | "${seg} Stop" | "Cancel"`,
        [`${seg} Start`, `${seg} Stop`, 'Cancel']
      );
    } catch {}
    return twiml(res, 'Choose an option above.');
  }

  return false;
}

// Backfill confirm (>2 min away)
if (tsOverrideIso) {
  const diffMin = Math.abs((new Date(tsOverrideIso) - now) / 60000);
  if (diffMin > 2) {
    try {
      if (typeof pg.savePendingAction === 'function') {
        await pg.savePendingAction({
          ownerId: String(ownerId || '').trim(),
          userId: targetUserId,
          kind: 'backfill_time',
          payload: {
            resolvedType,
            tsOverrideIso,
            jobName,
            source_msg_id: stableMsgId
          }
        });
      }
    } catch {}

    const line = humanLine(resolvedType, userProfile?.name || 'You', tsOverrideIso, tz);
    try { await sendBackfillConfirm(from, line, { preferTemplate: true }); } catch {}
    return twiml(res, 'I sent a confirmation — reply **Confirm** or **Cancel**.');
  }
}

// FORCE commands
const mForceIn = rawNorm.match(/^force\s+clock\s+in\b/i);
const mForceOut = rawNorm.match(/^force\s+clock\s+out\b/i);

if (mForceIn || mForceOut) {
  const forcedType = mForceIn ? 'clock_in' : 'clock_out';
  const out = await execClockViaCil({
    ownerId,
    paUserId: targetUserId,
    target: targetUserId,
    tz,
    stableMsgId,
    jobName,
    resolvedType: forcedType, // ✅ use forcedType
    tsOverride: tsOverrideIso || null,
    nowIso: now.toISOString(),
    plan,
    role,
    crew_count,
    actorName,
  });

  return twimlWithTargetName(
    res,
    out?.text || '✅ Forced time action recorded.',
    {
      ownerId,
      actorId: paUserId,
      targetId: targetUserId,
      fallbackName: userProfile?.name || userProfile?.ProfileName || ''
    }
  );
}

    // UNDO (new schema)
    if (isUndo) {
      try {
        const del = await pg.query(
          `DELETE FROM public.time_entries_v2
            WHERE id = (
              SELECT id
                FROM public.time_entries_v2
               WHERE owner_id=$1 AND user_id=$2
               ORDER BY coalesce(start_at_utc, created_at) DESC
               LIMIT 1
            )
            RETURNING id, kind, start_at_utc, created_at`,
          [String(ownerId || '').trim(), targetUserId]
        );

        if (!del.rowCount) return twiml(res, `Nothing to undo.`);

        const atHuman = del.rows[0].start_at_utc ? formatLocal(del.rows[0].start_at_utc, tz) : 'recently';
        let msg = `Undid last time entry (${del.rows[0].kind || 'entry'}) from ${atHuman}.`;

try {
  const suffix = await nameSuffix(ownerId, targetUserId);
  if (suffix) msg = msg.replace('Undid', `Undid${suffix}`);
} catch {}

return twiml(res, msg);

      } catch {
        return twiml(res, `Undo isn't available yet.`);
      }
    }

    // MAIN: ALWAYS CIL -> handleClock
const out = await execClockViaCil({
  ownerId,
  paUserId: targetUserId,
  target: targetUserId,
  tz,
  stableMsgId,
  jobName,
  resolvedType,
  tsOverride: tsOverrideIso || null,
  nowIso: now.toISOString(),
  plan,
  role,
  crew_count,
  actorName,
});

return twimlWithTargetName(
  res,
  out?.text || 'Time logged.',
  {
    ownerId,
    actorId: paUserId,
    targetId: targetUserId,
    fallbackName: userProfile?.name || userProfile?.ProfileName || ''
  }
);

  } catch (e) {
    console.error('[timeclock] error:', e?.message, { code: e?.code, detail: e?.detail });
    return twiml(res, 'Timeclock error. Try again.');
  } finally {
    try { res?.req?.releaseLock?.(); } catch {}
  }
}

/* ---------------- Timesheet (TOP-LEVEL ONLY — DO NOT PUT INSIDE handleTimeclock) ----------------
   NOTE: This assumes formatInTimeZone + zonedTimeToUtc are already in scope in this file.
   If not, add near your other requires:
   const { formatInTimeZone, zonedTimeToUtc } = require('date-fns-tz');
*/

const DEFAULT_TZ = 'America/Toronto';

function minsToHM(mins) {
  const m = Math.max(0, Number(mins) || 0);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

function fmtDateTime(ts, tz) {
  try {
    const d = new Date(ts);
    return formatInTimeZone(d, tz, "EEE MMM dd, h:mmaaa").replace('AM', 'am').replace('PM', 'pm');
  } catch {
    return String(ts);
  }
}

function startOfDayUtcIso(refDate, tz) {
  const y = Number(formatInTimeZone(refDate, tz, 'yyyy'));
  const m = Number(formatInTimeZone(refDate, tz, 'MM'));
  const d = Number(formatInTimeZone(refDate, tz, 'dd'));
  const local = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} 00:00:00`;
  return zonedTimeToUtc(local, tz).toISOString();
}

function addDaysUtcIso(utcIso, days) {
  const dt = new Date(utcIso);
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString();
}

function startOfWeekUtcIso(refDate, tz) {
  const localDow = Number(formatInTimeZone(refDate, tz, 'i')); // 1=Mon..7=Sun
  const daysSinceMon = localDow - 1;
  const sod = startOfDayUtcIso(refDate, tz);
  return addDaysUtcIso(sod, -daysSinceMon);
}

function computeRangeUtc(mode, tz, now = new Date()) {
  const zone = tz || DEFAULT_TZ;

  if (mode === 'today') {
    const startUtcIso = startOfDayUtcIso(now, zone);
    const endUtcIso = addDaysUtcIso(startUtcIso, 1);
    return { startUtcIso, endUtcIso, label: `Today (${zone})` };
  }

  if (mode === 'last_week') {
    const thisWeekStart = startOfWeekUtcIso(now, zone);
    const startUtcIso = addDaysUtcIso(thisWeekStart, -7);
    const endUtcIso = thisWeekStart;
    return { startUtcIso, endUtcIso, label: `Last week (${zone})` };
  }

  const startUtcIso = startOfWeekUtcIso(now, zone);
  const endUtcIso = addDaysUtcIso(startUtcIso, 7);
  return { startUtcIso, endUtcIso, label: `This week (${zone})` };
}

// ---------------- Name resolution (wired to services/users.js) ----------------

const _nameCache = new Map();     // key: `${owner_id}:${q}` -> [user_id]
const _displayCache = new Map();  // key: `${owner_id}:${user_id}` -> "Name"
const _CACHE_MAX = 500;           // evict when either cache exceeds this size

function _nameSet(k, v)    { if (_nameCache.size    >= _CACHE_MAX) _nameCache.clear();    _nameCache.set(k, v); }
function _displaySet(k, v) { if (_displayCache.size >= _CACHE_MAX) _displayCache.clear(); _displayCache.set(k, v); }

function _cacheKey(owner_id, s) {
  return `${String(owner_id || '').trim()}:${String(s || '').trim().toLowerCase()}`;
}

async function resolveUserIdsByName(owner_id, nameQuery, actorKey = null) {
  const ownerId = String(owner_id || '').trim();
  const qRaw = String(nameQuery || '').trim();
  const q = qRaw.toLowerCase();

  if (!ownerId || !qRaw) return null;

  // aliases
  if (q === 'crew') return ['crew'];
  if ((q === 'me' || q === 'my' || q === 'myself') && actorKey) return [String(actorKey).trim()];

  const ck = _cacheKey(ownerId, qRaw);
  if (_nameCache.has(ck)) return _nameCache.get(ck);

  // 1) If they typed digits, treat as user_id
  if (/^\d+$/.test(qRaw)) {
    const out = [qRaw];
    _nameSet(ck, out);
    return out;
  }

  // 2) Exact match using your helper (case-insensitive exact)
  try {
    const exact = await getUserByName(ownerId, qRaw);
    if (exact?.user_id) {
      const out = [String(exact.user_id)];
      _nameSet(ck, out);
      return out;
    }
  } catch {}

  // 3) Fuzzy fallback: find "Scott" inside "Scott Jutras"
  // Only searches team members under this owner.
  try {
    const like = `%${qRaw.replace(/%/g, '').replace(/_/g, '').trim()}%`;
    const { rows } = await pg.query(
      `SELECT user_id, name
         FROM public.users
        WHERE owner_id = $1
          AND is_team_member = true
          AND (lower(name) ILIKE lower($2))
        ORDER BY name ASC
        LIMIT 5`,
      [ownerId, like]
    );

    if (rows?.length === 1) {
      const out = [String(rows[0].user_id)];
      _nameSet(ck, out);
      return out;
    }

    // If multiple hits, fail-soft with null (caller prints "I don't recognize")
    // You can later upgrade this to show a picker.
  } catch {}

  _nameSet(ck, null);
  return null;
}

async function displayNameForUserId(owner_id, user_id) {
  const ownerId = String(owner_id || '').trim();
  const uid = String(user_id || '').trim();
  if (!uid) return 'Unknown';

  if (uid.toLowerCase() === 'crew') return 'Crew';

  const ck = _cacheKey(ownerId, uid);
  if (_displayCache.has(ck)) return _displayCache.get(ck);

  // If it's digits, fetch name from users table
  if (/^\d+$/.test(uid)) {
    try {
      const u = await getUserBasic(uid);
      const nm = String(u?.name || '').trim();
      if (nm) {
        _displaySet(ck, nm);
        return nm;
      }
    } catch {}
  }

  // fallback: show id
  _displaySet(ck, uid);
  return uid;
}



async function handleTimesheetCommand({ ownerId, actorKey, text, req, res }) {
  const owner_id = String(ownerId || '').trim();
  if (!owner_id) return false;

  const tz = req?.userProfile?.tz || req?.userProfile?.timezone || DEFAULT_TZ;

  const raw = String(text || '').trim();
  const s = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!/^timesheet\b/.test(s)) return false;

  // -----------------------------
  // 1) export intent (pdf/xlsx)
  // -----------------------------
  const wantsXlsx = /\b(xlsx|excel)\b/.test(s);
  const wantsPdf = /\bpdf\b/.test(s);
  const wantsExport = wantsXlsx || wantsPdf;
  const exportKind = wantsPdf ? 'export_pdf' : 'export_xlsx';

  // -----------------------------
  // 2) range intent
  // -----------------------------
  const rangeMode =
    /\btoday\b/.test(s) ? 'today' :
    /\blast week\b/.test(s) ? 'last_week' :
    'week';

// -----------------------------
// 3) "who" intent (crew / me / name / digits)
// -----------------------------
const whoToken = (tok) => `__WHO__${tok}__`;

const cleanedWho = s
  .replace(/^timesheet\b/, '')
  .replace(/\b(last week|today|week)\b/g, '') // "last week" must be first
  .replace(/\b(crew|me|my|mine)\b/g, (m) => whoToken(m.toLowerCase()))
  .replace(/\b(pdf|xlsx|excel)\b/g, '')
  .replace(/\s+/g, ' ')
  .trim();

let who = null;

const hasCrew = cleanedWho.includes(whoToken('crew')) || /\btimesheet\s+crew\b/.test(s);
const hasMe =
  cleanedWho.includes(whoToken('me')) ||
  cleanedWho.includes(whoToken('my')) ||
  cleanedWho.includes(whoToken('mine')) ||
  /\btimesheet\s+(me|my|mine)\b/.test(s);

if (hasCrew) {
  who = 'crew';
} else if (hasMe) {
  who = String(actorKey || '').trim() || null;
} else if (cleanedWho) {
  who =
    cleanedWho
      .replace(/__WHO__\w+__/g, '')
      .replace(/\s+/g, ' ')
      .trim() || null;
}

const { startUtcIso, endUtcIso, label } = computeRangeUtc(rangeMode, tz, new Date());



  // -----------------------------
  // 4) resolve filterUserIds
  // -----------------------------
  let filterUserIds = null;
  let titleWhoLabel = null;

  if (who) {
    const w = String(who).trim();

    if (/^crew$/i.test(w)) {
      filterUserIds = null; // crew = all users under owner
      titleWhoLabel = 'Crew';
    } else if (/^\d+$/.test(w)) {
      filterUserIds = [w];
      titleWhoLabel = await displayNameForUserId(owner_id, w);
    } else {
      // name -> user ids
      const hit = await resolveUserIdsByName(owner_id, w, actorKey);
      if (!hit?.length) {
        return twiml(
          res,
          `I don’t recognize "${who}".\n\nTry:\n- timesheet week\n- timesheet me\n- timesheet crew\n- timesheet Jaclyn\n- timesheet week xlsx`
        );
      }
      // If multiple matches, we can either fail or pick the first.
      // For now: if >1, fail soft with guidance (prevents wrong payroll).
      if (hit.length > 1) {
        return twiml(
          res,
          `I found multiple matches for "${who}". Try a more specific name, or use:\n- timesheet crew\n- timesheet <phone digits>`
        );
      }
      filterUserIds = [String(hit[0]).trim()];
      titleWhoLabel = await displayNameForUserId(owner_id, filterUserIds[0]);
    }
  } else {
    // default = actor
    filterUserIds = actorKey ? [String(actorKey).trim()] : null;
    titleWhoLabel = filterUserIds?.[0] ? await displayNameForUserId(owner_id, filterUserIds[0]) : null;
  }

  // -----------------------------
  // 5) resolve planKey for export gates
  // -----------------------------
  let ownerProfile = null;
  try {
    if (typeof pg.getOwnerProfile === 'function') {
      ownerProfile = await pg.getOwnerProfile(owner_id);
    }
  } catch {}

  const { getEffectivePlanFromOwner } = require("../../src/config/effectivePlan");

// planKey here should also be effective (status-aware)
const planKey = getEffectivePlanFromOwner(ownerProfile || req?.userProfile);


  const ownerIdKey = String(owner_id || '').trim();

  // -----------------------------
  // 6) EXPORT path (v2-first)
  // -----------------------------
  if (wantsExport) {
    // Quota gate with reason (NOT_INCLUDED vs OVER_QUOTA)
    try {
      const q = await checkMonthlyQuota({ ownerId: ownerIdKey, planKey, kind: exportKind, units: 1 });
      if (!q.ok) {
        // flip upsell flag once (export)
        try {
          const r = await shouldShowUpgradePromptOnce({ ownerId: ownerIdKey, kind: exportKind });
          console.info('[UPSELL_FLAG]', { kind: exportKind, ownerId: ownerIdKey, ...r });
        } catch {}

        const whoLine = titleWhoLabel ? ` (${titleWhoLabel})` : '';
        if (q.reason === 'NOT_INCLUDED') {
          return twiml(
            res,
            `📤 Exports aren’t included on your plan.\n\nUpgrade to Starter or Pro to export ${wantsPdf ? 'PDF' : 'XLSX'} timesheets${whoLine}.`
          );
        }
        // OVER_QUOTA
        if (planKey === 'pro') {
          return twiml(
            res,
            `📤 You’ve used your monthly ${wantsPdf ? 'PDF' : 'XLSX'} export allowance.\n\nYour limit resets next month. For now, you can still view the timesheet summary in chat.`
          );
        }
        return twiml(
          res,
          `📤 You’ve used your monthly ${wantsPdf ? 'PDF' : 'XLSX'} export allowance.\n\nYou can:\n• Wait until next month\n• Upgrade for higher capacity\n• Use the chat summary now (no export needed)`
        );
      }
    } catch (e) {
      console.warn('[TIMESHEET_EXPORT] quota gate failed (fail-open):', e?.message);
    }

    // consume BEFORE export (matches your quota pattern)
    try {
      await consumeMonthlyQuota({ ownerId: ownerIdKey, kind: exportKind, units: 1 });
    } catch (e) {
      console.warn('[TIMESHEET_EXPORT] consume failed (ignored):', e?.message);
    }

    // Export using v2 exports if present, else fallback
    try {
      const startIso = startUtcIso;
      const endIso = endUtcIso;

      const opts = {
        ownerId: ownerIdKey,
        startIso,
        endIso,
        tz,
        filterUserIds: filterUserIds && filterUserIds.length ? filterUserIds : null
      };

      let out = null;
      if (wantsPdf && typeof pg.exportTimesheetPdfV2 === 'function') out = await pg.exportTimesheetPdfV2(opts);
      if (wantsXlsx && typeof pg.exportTimesheetXlsxV2 === 'function') out = await pg.exportTimesheetXlsxV2(opts);

      // fallback to legacy exports if v2 ones not present
      if (!out && wantsPdf && typeof pg.exportTimesheetPdf === 'function') {
        // legacy expects employeeName; if you *must* use it, only allow when single user and name exists
        if (filterUserIds?.length === 1) {
          const nm = await displayNameForUserId(owner_id, filterUserIds[0]);
          out = await pg.exportTimesheetPdf({ ownerId: ownerIdKey, startIso, endIso, employeeName: nm || null, tz });
        } else {
          out = await pg.exportTimesheetPdf({ ownerId: ownerIdKey, startIso, endIso, employeeName: null, tz });
        }
      }
      if (!out && wantsXlsx && typeof pg.exportTimesheetXlsx === 'function') {
        if (filterUserIds?.length === 1) {
          const nm = await displayNameForUserId(owner_id, filterUserIds[0]);
          out = await pg.exportTimesheetXlsx({ ownerId: ownerIdKey, startIso, endIso, employeeName: nm || null, tz });
        } else {
          out = await pg.exportTimesheetXlsx({ ownerId: ownerIdKey, startIso, endIso, employeeName: null, tz });
        }
      }

      if (!out?.url) return twiml(res, `⚠️ Export is temporarily unavailable. Please try again.`);

      const whoLine = titleWhoLabel ? ` — ${titleWhoLabel}` : '';
      return twiml(res, `✅ ${wantsPdf ? 'PDF' : 'XLSX'} ready${whoLine}:\n${out.url}`);
    } catch (e) {
      console.warn('[TIMESHEET_EXPORT] export failed:', e?.message);
      return twiml(res, `⚠️ Export is temporarily unavailable. Please try again.`);
    }
  }

  // -----------------------------
  // 7) SUMMARY path (Timesheet Truth, v2)
  // -----------------------------

  // 7a) pull shifts for range + filter
  const params = [owner_id, startUtcIso, endUtcIso];
  let sql = `
    SELECT id, user_id, start_at_utc, end_at_utc, meta
      FROM public.time_entries_v2
     WHERE owner_id = $1
       AND kind = 'shift'
       AND deleted_at IS NULL
       AND end_at_utc IS NOT NULL
       AND start_at_utc >= $2::timestamptz
       AND start_at_utc <  $3::timestamptz
  `;

  if (filterUserIds?.length) {
    params.push(filterUserIds);
    sql += ` AND user_id = ANY($4::text[]) `;
  }

  sql += ` ORDER BY user_id, start_at_utc ASC`;

  const { rows: shiftRows } = await pg.query(sql, params);
  if (!shiftRows?.length) {
    const whoLine = titleWhoLabel ? ` for ${titleWhoLabel}` : '';
    return twiml(
      res,
      `No shifts found${whoLine} for ${label}.\n\nTry:\n- timesheet week\n- timesheet me\n- timesheet crew\n- timesheet week xlsx\n- timesheet week pdf`
    );
  }

  // 7b) load children for those shifts (one query)
  const shiftIds = shiftRows.map((r) => r.id).filter(Boolean);
  let childRows = [];
  try {
    const { rows } = await pg.query(
      `
      SELECT parent_id, kind, start_at_utc, end_at_utc
        FROM public.time_entries_v2
       WHERE owner_id = $1
         AND deleted_at IS NULL
         AND parent_id = ANY($2::uuid[])
         AND kind IN ('break','lunch','drive')
      `,
      [owner_id, shiftIds]
    );
    childRows = rows || [];
  } catch (e) {
    console.warn('[TIMESHEET] child fetch failed (ignored):', e?.message);
  }

  // 7c) per-shift “truth” calc
  const byShiftId = new Map(); // shift_id -> {break,lunch,drive}
  for (const c of (childRows || [])) {
    const pid = c.parent_id;
    if (!pid) continue;
    if (!byShiftId.has(pid)) byShiftId.set(pid, { breakM: 0, lunchM: 0, driveM: 0 });

    const agg = byShiftId.get(pid);
    const mins = Math.max(
      0,
      Math.round((new Date(c.end_at_utc).getTime() - new Date(c.start_at_utc).getTime()) / 60000)
    );

    if (c.kind === 'break') agg.breakM += mins;
    if (c.kind === 'lunch') agg.lunchM += mins;
    if (c.kind === 'drive') agg.driveM += mins;
  }

  // 7d) aggregate per user
  const byUser = new Map(); // user_id -> totals
  for (const sh of shiftRows) {
    const uid = String(sh.user_id || 'unknown').trim();
    if (!byUser.has(uid)) {
      byUser.set(uid, { shiftM: 0, breakM: 0, lunchM: 0, driveM: 0, workM: 0, paidM: 0 });
    }
    const u = byUser.get(uid);

    const shiftM = Math.max(
      0,
      Math.round((new Date(sh.end_at_utc).getTime() - new Date(sh.start_at_utc).getTime()) / 60000)
    );

    const seg = byShiftId.get(sh.id) || { breakM: 0, lunchM: 0, driveM: 0 };
    const workM = Math.max(0, shiftM - seg.breakM - seg.lunchM);

    // For now: paid = work (policy-agnostic summary)
    const paidM = workM;

    u.shiftM += shiftM;
    u.breakM += seg.breakM;
    u.lunchM += seg.lunchM;
    u.driveM += seg.driveM;
    u.workM += workM;
    u.paidM += paidM;
  }

  // 7e) render
  const lines = [];
  const whoTitle = (filterUserIds?.length === 1 && titleWhoLabel) ? ` — ${titleWhoLabel}` :
                   (!filterUserIds?.length && titleWhoLabel) ? ` — ${titleWhoLabel}` :
                   '';

  lines.push(`🧾 Timesheet${whoTitle} — ${label}`);
  lines.push(`Range: ${fmtDateTime(startUtcIso, tz)} → ${fmtDateTime(endUtcIso, tz)}`);
  lines.push('');

  // Individual summary (single person)
  if (filterUserIds?.length === 1) {
    const uid = filterUserIds[0];
    const a = byUser.get(uid);
    if (!a) return twiml(res, `No shifts found for ${label}.`);

    lines.push(`⏱️ Shift: ${minsToHM(a.shiftM)}`);
    lines.push(`☕ Breaks: ${minsToHM(a.breakM)}`);
    lines.push(`🥪 Lunch: ${minsToHM(a.lunchM)}`);
    lines.push(`🚗 Drive: ${minsToHM(a.driveM)} (tracked, not deducted)`);
    lines.push('');
    lines.push(`🧱 Work time (Shift − Break − Lunch): ${minsToHM(a.workM)}`);
    lines.push(`💵 Paid time: ${minsToHM(a.paidM)}`);

  } else {
    // Crew summary (per-person lines)
    let grand = { shiftM: 0, breakM: 0, lunchM: 0, driveM: 0, workM: 0, paidM: 0 };

    for (const [uid, a] of byUser.entries()) {
      const name = await displayNameForUserId(owner_id, uid);
      lines.push(
        `• ${name}: Paid ${minsToHM(a.paidM)} | Work ${minsToHM(a.workM)} | Break ${minsToHM(a.breakM)} | Lunch ${minsToHM(a.lunchM)} | Drive ${minsToHM(a.driveM)}`
      );

      grand.shiftM += a.shiftM;
      grand.breakM += a.breakM;
      grand.lunchM += a.lunchM;
      grand.driveM += a.driveM;
      grand.workM += a.workM;
      grand.paidM += a.paidM;
    }

    lines.push('');
    lines.push(`📌 Crew total`);
    lines.push(`💵 Paid: ${minsToHM(grand.paidM)} | 🧱 Work: ${minsToHM(grand.workM)} | ☕ Break: ${minsToHM(grand.breakM)} | 🥪 Lunch: ${minsToHM(grand.lunchM)} | 🚗 Drive: ${minsToHM(grand.driveM)}`);
  }

  lines.push('');
  lines.push(`Try:\n- timesheet week\n- timesheet me\n- timesheet crew\n- timesheet week xlsx\n- timesheet week pdf`);

  return twiml(res, lines.join('\n'));
}

// ---------- V2 EXCEL EXPORT (lazy load) ----------
let ExcelJS_V2 = null;
async function exportTimesheetXlsxV2(opts) {
  if (!ExcelJS_V2) ExcelJS_V2 = require('exceljs');

  const { ownerId, startIso, endIso, userId = null, tz = 'America/Toronto' } = opts;
  const owner = DIGITS(ownerId);
  const uid = userId ? String(userId).trim() : null;

  const params = uid ? [owner, startIso, endIso, uid] : [owner, startIso, endIso];

  const { rows } = await queryWithTimeout(
    `
    SELECT te.user_id,
           te.start_at_utc,
           te.end_at_utc,
           COALESCE((te.meta->'calc'->>'paidMinutes')::int, 0) AS paid_minutes,
           COALESCE((te.meta->'calc'->>'driveTotal')::int, 0) AS drive_minutes,
           COALESCE(j.name, j.job_name, te.job_name, '') AS job_name
      FROM public.time_entries_v2 te
      LEFT JOIN public.jobs j
        ON j.owner_id = te.owner_id
       AND (j.id::text = COALESCE(NULLIF(te.job_id::text,''), NULL))
     WHERE te.owner_id = $1
       AND te.kind = 'shift'
       AND te.deleted_at IS NULL
       AND te.end_at_utc IS NOT NULL
       AND te.start_at_utc >= $2::timestamptz
       AND te.start_at_utc <  $3::timestamptz
       ${uid ? 'AND te.user_id = $4' : ''}
     ORDER BY te.user_id, te.start_at_utc ASC
    `,
    params,
    15000
  );

  const wb = new ExcelJS_V2.Workbook();
  const ws = wb.addWorksheet('Timesheet');

  ws.columns = [
    { header: 'UserId', key: 'user_id' },
    { header: 'Start (UTC)', key: 'start_at_utc' },
    { header: 'End (UTC)', key: 'end_at_utc' },
    { header: 'Paid Minutes', key: 'paid_minutes' },
    { header: 'Drive Minutes', key: 'drive_minutes' },
    { header: 'Job', key: 'job_name' }
  ];

  (rows || []).forEach((r) => ws.addRow(r));

  const buf = await wb.xlsx.writeBuffer();
  const id = crypto.randomBytes(12).toString('hex');

  const suffix = uid ? `_user_${uid}` : '';
  const filename = `timesheet_v2_${startIso.slice(0, 10)}_${endIso.slice(0, 10)}${suffix}.xlsx`;

  await query(
    `INSERT INTO public.file_exports (id, owner_id, filename, content_type, bytes, created_at)
     VALUES ($1,$2,$3,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',$4,NOW())`,
    [id, owner, filename, Buffer.from(buf)]
  );

  const base = process.env.PUBLIC_BASE_URL || '';
  return { url: `${base}/exports/${id}`, id, filename };
}

// ---------- V2 PDF EXPORT (lazy load) ----------
let PDFDocument_V2 = null;
async function exportTimesheetPdfV2(opts) {
  if (!PDFDocument_V2) PDFDocument_V2 = require('pdfkit');

  const { ownerId, startIso, endIso, userId = null, tz = 'America/Toronto' } = opts;
  const owner = DIGITS(ownerId);
  const uid = userId ? String(userId).trim() : null;

  const params = uid ? [owner, startIso, endIso, uid] : [owner, startIso, endIso];

  const { rows } = await queryWithTimeout(
    `
    SELECT te.user_id,
           te.start_at_utc,
           te.end_at_utc,
           COALESCE((te.meta->'calc'->>'paidMinutes')::int, 0) AS paid_minutes,
           COALESCE((te.meta->'calc'->>'driveTotal')::int, 0) AS drive_minutes,
           COALESCE(j.name, j.job_name, te.job_name, '') AS job_name,
           COALESCE(te.tz, $4) AS tz
      FROM public.time_entries_v2 te
      LEFT JOIN public.jobs j
        ON j.owner_id = te.owner_id
       AND (j.id::text = COALESCE(NULLIF(te.job_id::text,''), NULL))
     WHERE te.owner_id = $1
       AND te.kind = 'shift'
       AND te.deleted_at IS NULL
       AND te.end_at_utc IS NOT NULL
       AND te.start_at_utc >= $2::timestamptz
       AND te.start_at_utc <  $3::timestamptz
       ${uid ? 'AND te.user_id = $4' : ''}
     ORDER BY te.user_id, te.start_at_utc ASC
    `,
    uid ? params : [owner, startIso, endIso, tz],
    15000
  );

  const doc = new PDFDocument_V2({ margin: 40 });
  const chunks = [];
  doc.on('data', (d) => chunks.push(d));
  const done = new Promise((r) => doc.on('end', r));

  doc.fontSize(16).text(`Timesheet (v2) ${startIso.slice(0, 10)} – ${endIso.slice(0, 10)}`, { align: 'center' }).moveDown();

  (rows || []).forEach((r) => {
    doc
      .fontSize(10)
      .text(
        `User ${r.user_id} | paid ${r.paid_minutes}m | drive ${r.drive_minutes}m | ${r.job_name || ''} | ${r.start_at_utc} → ${r.end_at_utc}`
      );
  });

  doc.end();
  await done;

  const buf = Buffer.concat(chunks);
  const id = crypto.randomBytes(12).toString('hex');

  const suffix = uid ? `_user_${uid}` : '';
  const filename = `timesheet_v2_${startIso.slice(0, 10)}_${endIso.slice(0, 10)}${suffix}.pdf`;

  await query(
    `INSERT INTO public.file_exports (id, owner_id, filename, content_type, bytes, created_at)
     VALUES ($1,$2,$3,'application/pdf',$4,NOW())`,
    [id, owner, filename, buf]
  );

  const base = process.env.PUBLIC_BASE_URL || '';
  return { url: `${base}/exports/${id}`, id, filename };
}


// ✅ Export without clobbering
module.exports = {
  handleTimeclock,
  handleClock,
  handleTimesheetCommand,
  twimlWithTargetName,
  handleSegmentDurationRepairReply,
  
};


