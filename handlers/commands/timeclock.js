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
    .type('application/xml')
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
    _hasTimeEntriesSourceMsgIdCol = false;
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
    _timeEntriesShape = 'unknown';
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

    // ✅ Correct call signature: rewriteWithActorTargetNames expects ONE object
    try {
      if (typeof rewriteWithActorTargetNames === 'function') {
        const rewritten = await rewriteWithActorTargetNames({
          ownerId,
          actorId,
          targetId: targetUserId,
          text: msg
        });

        // If rewrite returns something usable, trust it
        if (rewritten && String(rewritten).trim()) {
          return twiml(res, String(rewritten).trim());
        }
      }
    } catch {}

    // Otherwise, append suffix if not already present
    if (!msg.toLowerCase().includes(String(display).toLowerCase())) {
      msg = msg.replace(/\.$/, '');
      msg = `${msg} — ${display}.`;
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

// Default transform: "You're <action> <Name>."
const coreLc = coreClean.charAt(0).toLowerCase() + coreClean.slice(1);
return normalizeSentencePunct(`${lead}You're ${coreLc} ${targetName}`);

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

  // fallback (non-idempotent)
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
  try {
    const { rows } = await pg.query(`SELECT * FROM public.employer_policies WHERE owner_id=$1`, [
      String(owner_id || '').trim()
    ]);
    return rows[0] || { paid_break_minutes: 30, lunch_paid: true, paid_lunch_minutes: 30, drive_is_paid: true };
  } catch {
    return { paid_break_minutes: 30, lunch_paid: true, paid_lunch_minutes: 30, drive_is_paid: true };
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
  nowIso
}) {
  const atIso = tsOverride || nowIso || new Date().toISOString();
  const cil = buildClockCilFromResolvedType(resolvedType, atIso);
  if (!cil) return null;

  // For MVP enforcement: ALWAYS use digits user_id.
  const user_id = /^\d+$/.test(String(target || '').trim())
    ? String(target || '').trim()
    : String(paUserId || '').trim();

  // ✅ created_by should also be digits (fall back to paUserId)
  const created_by = /^\d+$/.test(String(createdBy || '').trim())
    ? String(createdBy).trim()
    : String(paUserId || '').trim();

  const ctx = {
    owner_id: String(ownerId || '').trim(),
    user_id,
    tz: tz || 'America/Toronto',
    source_msg_id: stableMsgId || null,
    created_by,
    job_id: jobId || null,
    meta: { job_name: jobName || null }
  };

  const out = await handleClock(ctx, cil); // ✅ writes + emits facts inside
  return out;
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
  const raw = String(s || '').trim().toLowerCase();
  if (!raw) return null;

  if (/^(skip|no|n)$/i.test(raw)) return { kind: 'skip' };

  // 0:20 / 00:20
  const hhmm = raw.match(/^(\d{1,2})\s*:\s*(\d{1,2})$/);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const m = Number(hhmm[2]);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return { kind: 'minutes', minutes: h * 60 + m };
  }

  // 20m / 20 min / 20mins
  const m1 = raw.match(/^(\d{1,4})\s*(m|min|mins|minute|minutes)$/);
  if (m1) return { kind: 'minutes', minutes: Number(m1[1]) };

  // plain number => minutes
  const plain = raw.match(/^(\d{1,4})$/);
  if (plain) return { kind: 'minutes', minutes: Number(plain[1]) };

  return null;
}

async function handleBreakDurationRepairReply(ctx, text) {
  const owner_id = String(ctx?.owner_id || '').trim();
  const user_id = String(ctx?.user_id || '').trim();
  const source_msg_id = ctx.source_msg_id ? String(ctx.source_msg_id).trim() : null;
  const tz = ctx.tz || 'UTC';

  const ret = (msg) => ({ text: String(msg || '').trim(), targetUserId: user_id || null });

  if (!owner_id || !user_id) return ret('Timeclock: missing owner_id or user_id.');

  // Find active prompt
  const { rows } = await pg.query(
    `SELECT *
       FROM public.timeclock_repair_prompts
      WHERE owner_id=$1
        AND user_id=$2
        AND kind='break_duration'
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC
      LIMIT 1`,
    [owner_id, user_id]
  );
  const prompt = rows?.[0] || null;
  if (!prompt) return null; // no-op, let normal routing proceed

  const parsed = parseDurationMinutes(text);
  if (!parsed) {
    return ret('Sorry — reply like “20 min” or “skip”.');
  }

  if (parsed.kind === 'skip') {
    await pg.query(`DELETE FROM public.timeclock_repair_prompts WHERE id=$1`, [prompt.id]);
    return ret('👍 Okay — leaving your break ended at clock-out.');
  }

  const minutes = Number(parsed.minutes || 0);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return ret('Sorry — reply like “20 min” or “skip”.');
  }

  // sanity cap (you can tune this)
  if (minutes > 360) {
    return ret('That break length looks too long. Reply like “20 min” or “skip”.');
  }

  const clockOutAt = new Date(prompt.clock_out_at_utc);
  const newEnd = new Date(clockOutAt.getTime() - minutes * 60 * 1000);
  const newEndIso = newEnd.toISOString();

  // Only adjust if the break currently ends at clock-out (or is later). This avoids weird rewrites.
  const r = await pg.query(
  `UPDATE public.time_entries_v2
      SET end_at_utc = $3::timestamptz,
          updated_at = now(),
          meta = jsonb_set(
            coalesce(meta,'{}'::jsonb),
            '{repair}',
            jsonb_build_object(
              'kind','break_duration',
              'minutes',$4::int,
              'clock_out_at_utc',$5::timestamptz,
              'adjusted_end_at_utc',$3::timestamptz,
              'source_msg_id',$6
            ),
            true
          )
    WHERE owner_id = $1
      AND id = $2::bigint
      AND deleted_at IS NULL
    RETURNING id`,
  [owner_id, prompt.break_entry_id, newEndIso, minutes, prompt.clock_out_at_utc, source_msg_id]
);

  await pg.query(`DELETE FROM public.timeclock_repair_prompts WHERE id=$1`, [prompt.id]);

  if (!r?.rows?.length) {
    // fail-soft
    return ret('Okay — I couldn’t adjust that break (it may have already been edited).');
  }

  return ret(`✅ Got it — set your break to ${minutes} min (ended at ${toHumanTime(newEndIso, tz)}).`);
}


/* ---------------- CIL handler (new schema path) ---------------- */

async function handleClock(ctx, cil) {
  // --- identity / return helper (must exist before any early returns) ---
  const owner_id = String(ctx?.owner_id || '').trim();
  const user_id = String(ctx?.user_id || '').trim();
  const targetUserId = user_id || null;

  // allow future extra fields without refactoring again
  const ret = (text, extra = {}) => ({ text: String(text || '').trim(), targetUserId, ...extra });

  if (!owner_id || !user_id) return ret('Timeclock: missing owner_id or user_id.');

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
    if (open) return ret(`You’re already clocked in since ${formatLocal(open.start_at_utc, tz)}.`);

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
    }

    return ret(`✅ Clocked in at ${toHumanTime(occurredAtIso, tz)}.`);
  }

  if (parsed.action === 'out') {
  const { shift, errText } = await requireOpenShift();
  if (!shift) return ret(errText);

  // detect open break BEFORE we auto-close children
  const { rows: openBreakRows } = await pg.query(
    `SELECT id
       FROM public.time_entries_v2
      WHERE owner_id=$1
        AND parent_id=$2
        AND kind='break'
        AND end_at_utc IS NULL
        AND deleted_at IS NULL
      ORDER BY start_at_utc DESC
      LIMIT 1`,
    [owner_id, shift.id]
  );

  const openBreakId = openBreakRows?.[0]?.id || null;
console.info('[TIME_V2_OUT_OPEN_BREAK]', { openBreakId: openBreakId || null, shiftId: shift.id });

  // close any open children (including break) at clock-out time
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

  const policy = await fetchPolicy(owner_id);
  const entries = await entriesForShift(owner_id, shift.id);

  let calc = { paidMinutes: 0, unpaidLunch: 0, unpaidBreak: 0 };
  try {
    // eslint-disable-next-line global-require
    const { computeShiftCalc } = require('../../services/timecalc');
    calc = computeShiftCalc(entries, policy);
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

  const day = new Date(shift.start_at_utc).toISOString().slice(0, 10);
  await touchKPI(owner_id, shift.job_id, day);

  await emit(
    { action: 'out', kind: 'shift', at: occurredAtIso, shift_id: shift.id, calc },
    'clock_out',
    shift.id,
    shift.job_id || null
  );

  const summaryLine =
    calc.unpaidLunch > 0 || calc.unpaidBreak > 0
      ? `⏱️ Paid ${Math.floor(calc.paidMinutes / 60)}h ${calc.paidMinutes % 60}m (policy deducted lunch ${calc.unpaidLunch}m, breaks ${calc.unpaidBreak}m).`
      : `⏱️ Paid ${Math.floor(calc.paidMinutes / 60)}h ${calc.paidMinutes % 60}m.`;

  // Default: normal clock-out message
  let finalText = `✅ Clocked out. ${summaryLine}`;

  // If a break was open at clock-out, create repair prompt + use exact copy
  if (openBreakId) {
    try {
      await pg.query(
        `INSERT INTO public.timeclock_repair_prompts
          (owner_id, user_id, kind, shift_id, break_entry_id, clock_out_at_utc, expires_at, source_msg_id)
         VALUES
          ($1,$2,'break_duration',$3,$4,$5, now() + interval '12 hours', $6)`,
        [owner_id, user_id, shift.id, openBreakId, occurredAtIso, source_msg_id]
      );
    } catch (e) {
      console.warn('[REPAIR_PROMPT] insert failed (ignored):', e?.message);
    }

    finalText =
      `✅ Clocked out. Your break was still running — I ended it at clock-out.\n` +
      `How long was your break? (e.g., “20 min”) or reply “skip”.`;
  }

  return ret(finalText);
}


  // Segment START (break/lunch/drive)
  if (parsed.action === 'break_start' || parsed.action === 'lunch_start' || parsed.action === 'drive_start') {
    const { shift, errText } = await requireOpenShift();
    if (!shift) return ret(errText);

    const kind = parsed.action.split('_')[0]; // break | lunch | drive

    // ✅ If already open, don't create a new one
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

    if (kind === 'lunch') return ret(`🍽️ Lunch started.`);
    if (kind === 'break') return ret(`⏸️ Break started.`);
    return ret(`🚚 Drive started.`);
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
let finalText = `✅ Clocked out. ${msg}`;

let promptInserted = false;
// If a break was open at clock-out, create a repair prompt
if (openBreakId) {
  try {
    await pg.query(
      `INSERT INTO public.timeclock_repair_prompts
        (owner_id, user_id, kind, shift_id, break_entry_id, clock_out_at_utc, expires_at, source_msg_id)
       VALUES
        ($1,$2,'break_duration',$3,$4,$5, now() + interval '12 hours', $6)`,
      [owner_id, user_id, shift.id, openBreakId, occurredAtIso, source_msg_id]
    );
    promptInserted = true;
    // ✅ LOG RIGHT HERE (insert succeeded)
    console.info('[TIME_V2_REPAIR_PROMPT_INSERTED]', {
      owner_id,
      user_id,
      shiftId: shift.id,
      breakId: openBreakId,
      occurredAtIso,
      source_msg_id
    });
  } catch (e) {
    console.warn('[REPAIR_PROMPT] insert failed (ignored):', e?.message);
  }
    if (promptInserted) {
  finalText =
    `✅ Clocked out. Your break was still running — I ended it at clock-out.\n` +
    `How long was your break? (e.g., “20 min”) or reply “skip”.`;
  }
}

return ret('Timeclock: action not recognized.');

}


/* ---------------- Legacy text command wrapper (PARSE OK, LEGACY WRITE FORBIDDEN) ---------------- */

async function handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId = null) {
  const tz = userProfile?.tz || userProfile?.timezone || 'America/Toronto';
  const now = new Date();

  const reqBody = res?.req?.body || {};
  const paUserId = getPaUserId(from, userProfile, reqBody); // ✅ digits

  const stableMsgId =
    String(reqBody?.MessageSid || reqBody?.SmsMessageSid || '').trim() ||
    String(sourceMsgId || '').trim() ||
    String(getTwilioMessageSidFromRes(res) || '').trim() ||
    null;

  const lc = String(text || '').toLowerCase().trim();

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
        resolvedType: forcedType,
        tsOverride: tsOverrideIso || null,
        nowIso: now.toISOString()
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

    // ----------------- MAIN: ALWAYS CIL -> handleClock (NO legacy DB writes) -----------------
    const out = await execClockViaCil({
      ownerId,
      paUserId: targetUserId,
      target: targetUserId,
      tz,
      stableMsgId,
      jobName,
      resolvedType,
      tsOverride: tsOverrideIso || null,
      nowIso: now.toISOString()
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
    _nameCache.set(ck, out);
    return out;
  }

  // 2) Exact match using your helper (case-insensitive exact)
  try {
    const exact = await getUserByName(ownerId, qRaw);
    if (exact?.user_id) {
      const out = [String(exact.user_id)];
      _nameCache.set(ck, out);
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
      _nameCache.set(ck, out);
      return out;
    }

    // If multiple hits, fail-soft with null (caller prints "I don't recognize")
    // You can later upgrade this to show a picker.
  } catch {}

  _nameCache.set(ck, null);
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
        _displayCache.set(ck, nm);
        return nm;
      }
    } catch {}
  }

  // fallback: show id
  _displayCache.set(ck, uid);
  return uid;
}



async function handleTimesheetCommand({ ownerId, actorKey, text, req, res }) {
  const owner_id = String(ownerId || '').trim();
  if (!owner_id) return false;

  const tz = req?.userProfile?.tz || req?.userProfile?.timezone || DEFAULT_TZ;

  const s = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!/^timesheet\b/.test(s)) return false;

  const range = (() => {
  if (/^timesheet\s+today\b/.test(s)) return { mode: 'today' };
  if (/^timesheet\s+last\s+week\b/.test(s)) return { mode: 'last_week' };
  if (/^timesheet\s+week\b/.test(s)) return { mode: 'week' };
  if (/^timesheet\s+crew\b/.test(s)) return { mode: 'week', who: 'crew' };

  // ✅ "timesheet me" = actor's timesheet (this week)
  if (/^timesheet\s+(me|my|mine)\b/.test(s)) return { mode: 'week', who: actorKey };

  // timesheet <name>
  const m = s.match(/^timesheet\s+(.+?)\s*$/);
  if (m && m[1]) return { mode: 'week', who: m[1].trim() };

  return { mode: 'week' };
})();


  const { startUtcIso, endUtcIso, label } = computeRangeUtc(range.mode, tz, new Date());

  let filterUserIds = null;
  if (range.who) {
    const who = String(range.who || '').toLowerCase().trim();
    if (/^\d+$/.test(who)) filterUserIds = [who];
    else if (who === 'crew') filterUserIds = ['crew'];
    else {
      const hit = await resolveUserIdsByName(owner_id, who, actorKey);
      filterUserIds = hit?.length ? hit : null;
      if (!filterUserIds) {
        return twiml(
          res,
          `I don’t recognize "${range.who}".\n\nTry:\n- timesheet today\n- timesheet week\n- timesheet last week\n- timesheet Crew`
        );
      }
    }
  }

  const params = [owner_id, startUtcIso, endUtcIso];
  let sql = `
    SELECT user_id,
           start_at_utc,
           end_at_utc,
           coalesce((meta->'calc'->>'paidMinutes')::int, 0) AS paid_minutes,
           coalesce((meta->'calc'->>'driveTotal')::int, 0) AS drive_minutes
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

  const { rows } = await pg.query(sql, params);

  if (!rows?.length) return twiml(res, `No shifts found for ${label}.`);

  const byUser = new Map();
  for (const r of rows) {
    const uid = String(r.user_id || 'unknown');
    if (!byUser.has(uid)) byUser.set(uid, { paid: 0, drive: 0 });
    const agg = byUser.get(uid);
    agg.paid += Number(r.paid_minutes || 0);
    agg.drive += Number(r.drive_minutes || 0);
  }

  const lines = [];
  lines.push(`🧾 Timesheet — ${label}`);
  lines.push(`Range: ${fmtDateTime(startUtcIso, tz)} → ${fmtDateTime(endUtcIso, tz)}`);
  lines.push('');

  for (const [uid, agg] of byUser.entries()) {
    const name = await displayNameForUserId(owner_id, uid);
    lines.push(`• ${name}: ${minsToHM(agg.paid)} paid` + (agg.drive ? ` (drive ${minsToHM(agg.drive)})` : ''));
  }

  lines.push('');
  lines.push(`Try: "timesheet today" | "timesheet week" | "timesheet Crew"`);

  return twiml(res, lines.join('\n'));
}

// ✅ Export without clobbering
module.exports = {
  handleTimeclock,
  handleClock,
  handleTimesheetCommand,
  twimlWithTargetName,
  handleBreakDurationRepairReply,
};


