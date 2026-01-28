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
const IN_TYPES = new Set(['in', 'clock_in', 'punch_in']);
const OUT_TYPES = new Set(['out', 'clock_out', 'punch_out', 'end', 'finish']);

const TIME_WORDS = new Set([
  'today',
  'yesterday',
  'tomorrow',
  'tonight',
  'this morning',
  'this afternoon',
  'this evening',
  'morning',
  'afternoon',
  'evening',
  'night',
  'now',
  'later'
]);

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
    _hasTimeEntriesSourceMsgIdCol = await hasColumn('time_entries', 'source_msg_id');
  } catch {
    _hasTimeEntriesSourceMsgIdCol = false;
  }
  return _hasTimeEntriesSourceMsgIdCol;
}

async function detectTimeEntriesShape() {
  if (_timeEntriesShape) return _timeEntriesShape;
  try {
    const hasKind = await hasColumn('time_entries', 'kind');
    const hasStartUtc = await hasColumn('time_entries', 'start_at_utc');
    const hasEmployeeName = await hasColumn('time_entries', 'employee_name');
    const hasTimestamp = await hasColumn('time_entries', 'timestamp');
    const hasType = await hasColumn('time_entries', 'type');

    if (hasKind && hasStartUtc) _timeEntriesShape = 'new';
    else if (hasEmployeeName && hasTimestamp && hasType) _timeEntriesShape = 'legacy';
    else _timeEntriesShape = 'unknown';
  } catch {
    _timeEntriesShape = 'unknown';
  }
  return _timeEntriesShape;
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
       FROM public.time_entries
      WHERE owner_id = $1
        AND user_id = $2
        AND kind = 'shift'
        AND end_at_utc IS NULL
      ORDER BY start_at_utc DESC
      LIMIT 1`,
    [String(owner_id || '').trim(), String(user_id || '').trim()]
  );
  return rows[0] || null;
}

async function ensureNoOverlapChild(owner_id, parent_id, kind) {
  await pg.query(
    `UPDATE public.time_entries
        SET end_at_utc = now()
      WHERE owner_id = $1
        AND parent_id = $2
        AND kind = $3
        AND end_at_utc IS NULL`,
    [String(owner_id || '').trim(), parent_id, kind]
  );
}

async function insertEntry(row) {
  const ownerId = String(row.owner_id || '').trim();
  const userId = String(row.user_id || '').trim();

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
      row.created_by || null,
      String(row.source_msg_id || '').trim() || null
    ];

    const { rows } = await pg.query(
      `INSERT INTO public.time_entries (${cols.join(',')})
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
    row.created_by || null
  ];

  const { rows } = await pg.query(
    `INSERT INTO public.time_entries (${cols.join(',')})
     VALUES (${vals})
     RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function closeEntryById(owner_id, id) {
  const { rows } = await pg.query(
    `UPDATE public.time_entries
        SET end_at_utc = now(), updated_at = now()
      WHERE owner_id = $1
        AND id = $2
        AND end_at_utc IS NULL
      RETURNING *`,
    [String(owner_id || '').trim(), id]
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
    `SELECT kind, EXTRACT(EPOCH FROM (end_at_utc - start_at_utc))/60 AS minutes
       FROM public.time_entries
      WHERE owner_id=$1 AND (id=$2 OR parent_id=$2) AND end_at_utc IS NOT NULL`,
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
// ----------------- Precompiled regexes (micro-optimization) -----------------
const RE_CLOCK_IN  = /\b(clock|punch)\s*in\b/i;
const RE_CLOCK_OUT = /\b(clock|punch)\s*out\b/i;
const RE_CLOCKIN_WORD  = /\b(clockin|punchin|shiftin)\b/i;
const RE_CLOCKOUT_WORD = /\b(clockout|punchout|shiftout)\b/i;

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
    const user_id = String(employeeName || '').trim(); // best-effort mapping
    const openShift = await getOpenShift(owner_id, user_id);

    if (!openShift) return { hasOpenShift: false, openBreak: false, openDrive: false, lastShiftStart: null };

    const { rows } = await pg.query(
      `SELECT kind, start_at_utc, end_at_utc
         FROM public.time_entries
        WHERE owner_id=$1 AND parent_id=$2
        ORDER BY start_at_utc ASC`,
      [owner_id, openShift.id]
    );

    let openBreak = false;
    let openDrive = false;
    for (const r of rows || []) {
      if (r.kind === 'break' && !r.end_at_utc) openBreak = true;
      if (r.kind === 'drive' && !r.end_at_utc) openDrive = true;
    }

    return { hasOpenShift: true, openBreak, openDrive, lastShiftStart: openShift.start_at_utc };
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
    let openDrive = false;
    let lastShiftStart = null;

    for (const r of rows || []) {
      switch (r.type) {
        case 'clock_in':
        case 'punch_in':
          hasOpenShift = true;
          lastShiftStart = r.timestamp;
          break;
        case 'clock_out':
        case 'punch_out':
          hasOpenShift = false;
          openBreak = false;
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
        case 'drive_start':
          if (hasOpenShift) openDrive = true;
          break;
        case 'drive_stop':
        case 'drive_end':
          openDrive = false;
          break;
      }
    }

    return { hasOpenShift, openBreak, openDrive, lastShiftStart };
  }

  return { hasOpenShift: false, openBreak: false, openDrive: false, lastShiftStart: null };
}

/* ---------------- CIL handler (new schema path) ---------------- */

async function handleClock(ctx, cil) {
  if (!ClockCIL) {
    return { text: 'Timeclock: CIL schema missing. Please update schemas/cil.clock.' };
  }

  const parsed = ClockCIL.parse(cil); // throws on invalid
  const nowIso = new Date().toISOString();
  const at = parsed.at || nowIso;
  const occurredAtIso =
  at && !Number.isNaN(Date.parse(String(at)))
    ? new Date(String(at)).toISOString()
    : new Date().toISOString();

  const owner_id = String(ctx.owner_id || '').trim();
  const user_id = String(ctx.user_id || '').trim();
  const job_id = ctx.job_id || null;
  const created_by = ctx.created_by || null;
  const source_msg_id = ctx.source_msg_id ? String(ctx.source_msg_id).trim() : null;

  if (parsed.action === 'in') {
    const open = await getOpenShift(owner_id, user_id);
    if (open) return { text: `You’re already clocked in since ${formatLocal(open.start_at_utc, ctx.tz || 'UTC')}.` };

    const inserted = await insertEntry({
      owner_id,
      user_id,
      job_id,
      parent_id: null,
      kind: 'shift',
      start_at_utc: at,
      end_at_utc: null,
      created_by,
      meta: ctx.meta || {},
      source_msg_id
    });

  if (inserted) {
  try {
    await pg.insertFactEvent({
      owner_id,
      actor_key: user_id,
      event_type: 'timeclock.logged',
      entity_type: 'time_entry',
      entity_id: null,
      job_id: job_id || null,

      occurred_at: occurredAtIso,
      source_msg_id,
      source_kind: 'whatsapp_text',
      event_payload: { action: 'in', kind: 'shift', at },

      dedupe_key: `timeclock.logged:${String(source_msg_id || 'no_msg')}:clock_in`
    });
  } catch (e) {
    console.warn('[FACT_EVENT] timeclock.logged clock_in failed (ignored):', e?.message);
  }
}

    return { text: `✅ Clocked in at ${toHumanTime(at, ctx.tz || 'UTC')}.` };
  }

  if (parsed.action === 'out') {
  const shift = await getOpenShift(owner_id, user_id);
  if (!shift) return { text: `You’re not clocked in.` };

  await pg.query(
    `UPDATE public.time_entries SET end_at_utc=$3
      WHERE owner_id=$1 AND parent_id=$2 AND end_at_utc IS NULL`,
    [owner_id, shift.id, at]
  );

  await closeEntryById(owner_id, shift.id);

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
      `UPDATE public.time_entries
          SET meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{calc}', $3::jsonb)
        WHERE id=$1 AND owner_id=$2`,
      [shift.id, owner_id, JSON.stringify(calc)]
    );
  } catch {}

  const day = new Date(shift.start_at_utc).toISOString().slice(0, 10);
  await touchKPI(owner_id, shift.job_id, day);

  // ✅ Fact emission: shift clock-out (update-based, not insert-based)
try {
  await pg.insertFactEvent({
    owner_id,
    actor_key: user_id,
    event_type: 'timeclock.logged',
    entity_type: 'time_entry',
    entity_id: String(shift.id),
    job_id: shift.job_id || null,

    occurred_at: occurredAtIso,
    source_msg_id,
    source_kind: 'whatsapp_text',
    event_payload: { action: 'out', kind: 'shift', at, shift_id: shift.id, calc },

    dedupe_key: `timeclock.logged:${String(source_msg_id || 'no_msg')}:clock_out`
  });
} catch (e) {
  console.warn('[FACT_EVENT] timeclock.logged clock_out failed (ignored):', e?.message);
}

  const msg =
    calc.unpaidLunch > 0 || calc.unpaidBreak > 0
      ? `⏱️ Paid ${Math.floor(calc.paidMinutes / 60)}h ${calc.paidMinutes % 60}m (policy deducted lunch ${calc.unpaidLunch}m, breaks ${calc.unpaidBreak}m).`
      : `⏱️ Paid ${Math.floor(calc.paidMinutes / 60)}h ${calc.paidMinutes % 60}m.`;

  return { text: `✅ Clocked out. ${msg}` };
}

if (parsed.action === 'break_stop' || parsed.action === 'lunch_stop' || parsed.action === 'drive_stop') {
  const kind = parsed.action.split('_')[0];

  // capture which child was actually closed (best-effort)
  const r = await pg.query(
    `UPDATE public.time_entries
        SET end_at_utc=$3
      WHERE owner_id=$1 AND parent_id=$2 AND kind=$4 AND end_at_utc IS NULL
      RETURNING id`,
    [owner_id, shift.id, at, kind]
  );

  const childId = r?.rows?.[0]?.id ?? null;

  // ✅ Fact emission: segment stop
try {
  await pg.insertFactEvent({
    owner_id,
    actor_key: user_id,
    event_type: 'timeclock.logged',
    entity_type: 'time_entry',
    entity_id: childId != null ? String(childId) : null,
    job_id: shift.job_id || null,

    occurred_at: occurredAtIso,
    source_msg_id,
    source_kind: 'whatsapp_text',
    event_payload: { action: 'stop', kind, at, shift_id: shift.id, child_id: childId },

    dedupe_key: `timeclock.logged:${String(source_msg_id || 'no_msg')}:${kind}_stop`
  });
} catch (e) {
  console.warn('[FACT_EVENT] timeclock.logged child_stop failed (ignored):', e?.message);
}

  return { text: `⏹️ ${kind} stopped.` };
}

  return { text: 'Timeclock: action not recognized.' };
}

/* ---------------- Legacy text command wrapper ---------------- */

async function handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId = null) {
  const lc = String(text || '').toLowerCase().trim();
  const tz = userProfile?.tz || userProfile?.timezone || 'America/Toronto';
  const now = new Date();

  const reqBody = res?.req?.body || {};
  const paUserId = getPaUserId(from, userProfile, reqBody); // should return digits

  // ✅ Stable message id: prefer Twilio SID, else router sourceMsgId, else res extractor, else null
  const stableMsgId =
    String(reqBody?.MessageSid || reqBody?.SmsMessageSid || '').trim() ||
    String(sourceMsgId || '').trim() ||
    String(getTwilioMessageSidFromRes(res) || '').trim() ||
    null;

  try {
  
    if (lc === 'timeclock' || lc === 'help timeclock') {
      return twiml(
        res,
        `Timeclock — Quick guide:
• clock in / clock out (or punch in/out)
• break start / break stop
• drive start / drive stop
• undo last
• timesheet week
Tip: add @ Job Name for context (e.g., “clock in @ Roof Repair”).`
      );
    }

    // rate limit (fail-open if service errs)
    try {
      if (typeof pg.checkTimeEntryLimit === 'function') {
        const limit = await pg.checkTimeEntryLimit(ownerId, paUserId, { max: 8, windowSec: 30 });
        if (limit && limit.ok === false) return twiml(res, 'Too many actions — slow down for a few seconds.');
      }
    } catch {}

    const explicitJobName = extractJobHint(text) || null;
    const jobName = await resolveJobNameForActor({ ownerId, identityKey: paUserId, explicitJobName });

 // -------------------------------------------------
// ✅ Timeclock early-claim gate (prevents fallthrough to agent)
// Handles: clockin/clockout, clock in/out, punchin/out, break/drive, undo last
// -------------------------------------------------
const norm = normalizeTcText(text);
const rawNorm = norm.raw;
const compact = norm.compact;

// If it's clearly not timeclock, let other handlers try.
const looksLikeTimeclock =
  RE_CLOCK_IN.test(rawNorm) ||
  RE_CLOCK_OUT.test(rawNorm) ||
  RE_CLOCKIN_WORD.test(rawNorm) ||
  RE_CLOCKOUT_WORD.test(rawNorm) ||
  RE_HAS_BREAK.test(rawNorm) ||
  RE_HAS_DRIVE.test(rawNorm) ||
  /^undo(\s+last)?$/i.test(rawNorm) ||
  /^undo(last)?$/i.test(compact); // also catches "undolast"

if (!looksLikeTimeclock) return false;


const START_WORDS = ['start', 'starting', 'begin', 'on', 'going'];
const STOP_WORDS  = ['stop', 'end', 'off', 'finish', 'done'];

const CLOCK_IN_PATTERNS = [
  'clockin', 'punchin', 'startshift', 'startmyday', 'shiftin'
];
const CLOCK_OUT_PATTERNS = [
  'clockout', 'punchout', 'endshift', 'finishup', 'wrapup', 'shiftout'
];

// segment compact patterns (no spaces)
const BREAK_START_COMPACT = [
  'breakstart', 'startbreak', 'beginbreak', 'breakbegin', 'onbreak', 'breakon'
];
const BREAK_STOP_COMPACT = [
  'breakstop', 'stopbreak', 'endbreak', 'breakend', 'offbreak', 'breakoff'
];
const DRIVE_START_COMPACT = [
  'drivestart', 'startdrive', 'begindrive', 'drivebegin', 'ondrive', 'driveon'
];
const DRIVE_STOP_COMPACT = [
  'drivestop', 'stopdrive', 'enddrive', 'driveend', 'offdrive', 'driveoff'
];

let isClockIn =
  compactHasAny(compact, CLOCK_IN_PATTERNS) ||
  RE_CLOCK_IN.test(rawNorm) ||
  RE_CLOCKIN_WORD.test(rawNorm);

let isClockOut =
  compactHasAny(compact, CLOCK_OUT_PATTERNS) ||
  RE_CLOCK_OUT.test(rawNorm) ||
  RE_CLOCKOUT_WORD.test(rawNorm);


// BREAK start/stop (lots of synonyms)
let isBreakStart =
  compactHasAny(compact, BREAK_START_COMPACT) ||
  (/\bbreak\b/i.test(rawNorm) && hasAnyWord(rawNorm, START_WORDS)) ||
  hasBoth(rawNorm, 'on', 'break');

let isBreakStop =
  compactHasAny(compact, BREAK_STOP_COMPACT) ||
  (/\bbreak\b/i.test(rawNorm) && hasAnyWord(rawNorm, STOP_WORDS)) ||
  hasBoth(rawNorm, 'off', 'break');

// DRIVE start/stop
let isDriveStart =
  compactHasAny(compact, DRIVE_START_COMPACT) ||
  (/\bdrive\b/i.test(rawNorm) && hasAnyWord(rawNorm, START_WORDS)) ||
  hasBoth(rawNorm, 'on', 'drive');

let isDriveStop =
  compactHasAny(compact, DRIVE_STOP_COMPACT) ||
  (/\bdrive\b/i.test(rawNorm) && hasAnyWord(rawNorm, STOP_WORDS)) ||
  hasBoth(rawNorm, 'off', 'drive');

// If user says just "on break" we treat as start; if "off break" treat as stop
// (already covered above)

// If they said "start break" or "begin break", normalize that to start
// (already covered via START_WORDS)

// ✅ Undo stays the same
const isUndo =
  /^undo(\s+last)?$/i.test(rawNorm) ||
  /^undo(last)?$/i.test(compact);



    const explicitTarget = extractTargetName(lc);
    const narrative = extractNarrative(text);
    let target = explicitTarget || narrative?.name || userProfile?.name || from;

    const segNarr = extractSegmentNarrative(text);
    if (segNarr) {
      target = explicitTarget || segNarr.name || target;
      if (segNarr.seg === 'break') {
        if (segNarr.action === 'start') {
          isBreakStart = true;
          isBreakStop = false;
        } else {
          isBreakStop = true;
          isBreakStart = false;
        }
      } else if (segNarr.seg === 'drive') {
        if (segNarr.action === 'start') {
          isDriveStart = true;
          isDriveStop = false;
        } else {
          isDriveStop = true;
          isDriveStart = false;
        }
      }
    }

    if (TIME_WORDS.has(String(target).toLowerCase()) || /^me|myself|my$/i.test(target)) {
      target = userProfile?.name || from;
    }
    if (narrative && !isClockIn && !isClockOut) {
      if (narrative.action === 'in') isClockIn = true;
      if (narrative.action === 'out') isClockOut = true;
    }

    const whenTxt = extractAtWhen(text);
    const tsOverride = whenTxt ? parseLocalWhenToIso(whenTxt, tz, now) : null;

    // canonical legacy types (keeps compatibility with pg.logTimeEntryWithJob)
    const resolvedType =
      isClockIn ? 'clock_in'
      : isClockOut ? 'clock_out'
      : isBreakStart ? 'break_start'
      : isBreakStop ? 'break_stop'
      : isDriveStart ? 'drive_start'
      : isDriveStop ? 'drive_stop'
      : null;

    // If Undo, handle it explicitly (do NOT fall through)
if (isUndo) {
  // fall through to the undo branch later in the function
} else if (!resolvedType) {
  const hasBreak = RE_HAS_BREAK.test(rawNorm);
  const hasDrive = RE_HAS_DRIVE.test(rawNorm);

  if (hasBreak || hasDrive) {
    const seg = hasBreak ? 'Break' : 'Drive';
    try {
      await sendQuickReply(
        from,
        `Do you want me to ${seg.toLowerCase()} **start** or **stop** for ${target}${
          tsOverride ? ' at ' + formatLocal(tsOverride, tz) : ''
        }?\nReply: "${seg} Start" | "${seg} Stop" | "Cancel"`,
        [`${seg} Start`, `${seg} Stop`, 'Cancel']
      );
    } catch {}
    return twiml(res, 'Choose an option above.');
  }

  return false; // router can fall through to other handlers (agent, etc.)
}

    // Backfill confirm if >2 min away from now
    if (tsOverride) {
      const diffMin = Math.abs((new Date(tsOverride) - now) / 60000);
      if (diffMin > 2) {
        try {
          if (typeof pg.savePendingAction === 'function') {
            await pg.savePendingAction({
              ownerId: String(ownerId || '').trim(),
              userId: paUserId, // ✅ aligned identity
              kind: 'backfill_time',
              payload: { target, type: resolvedType, tsOverride, jobName, source_msg_id: stableMsgId }
            });
          }
        } catch {}

        const line = humanLine(resolvedType, target, tsOverride, tz);
        try {
          await sendBackfillConfirm(from, line, { preferTemplate: true });
        } catch {}
        return twiml(res, 'I sent a confirmation — reply **Confirm** or **Cancel**.');
      }
    }

    // force paths
const mForceIn = rawNorm.match(/^force\s+clock\s+in\s+(.+)$/i);
const mForceOut = rawNorm.match(/^force\s+clock\s+out\s+(.+)$/i);

const canLegacyWrite = typeof pg.logTimeEntryWithJob === 'function';

if (mForceIn) {
  const forced = mForceIn[1].trim();
  const forceType = 'clock_in';

  if (canLegacyWrite) {
    await pg.logTimeEntryWithJob(ownerId, forced, forceType, tsOverride || now, jobName, tz, {
      requester_id: paUserId,
      source_msg_id: stableMsgId
    });

    await emitTimeclockFact({
      ownerId,
      actorKey: paUserId,
      sourceMsgId: stableMsgId,
      resolvedType: forceType,   // ✅ explicit
      target: forced,            // ✅ forced, not target
      jobName,
      tsIso: (tsOverride || now).toISOString ? (tsOverride || now).toISOString() : String(tsOverride || now)
    });

    return twiml(res, `✅ Forced clock-in recorded for ${forced} at ${formatLocal(tsOverride || now, tz)}.`);
  }

  // New schema path: handleClock already emits facts in your updated handleClock.
  const out = await handleClock(
    { owner_id: ownerId, user_id: forced, tz, source_msg_id: stableMsgId, meta: { job_name: jobName || null } },
    { action: 'in', at: tsOverride || now.toISOString() }
  );
  return twiml(res, out?.text || '✅ Forced clock-in recorded.');
}

if (mForceOut) {
  const forced = mForceOut[1].trim();
  const forceType = 'clock_out';

  if (canLegacyWrite) {
    await pg.logTimeEntryWithJob(ownerId, forced, forceType, tsOverride || now, jobName, tz, {
      requester_id: paUserId,
      source_msg_id: stableMsgId
    });

    await emitTimeclockFact({
      ownerId,
      actorKey: paUserId,
      sourceMsgId: stableMsgId,
      resolvedType: forceType,   // ✅ explicit
      target: forced,
      jobName,
      tsIso: (tsOverride || now).toISOString ? (tsOverride || now).toISOString() : String(tsOverride || now)
    });

    return twiml(res, `✅ Forced clock-out recorded for ${forced} at ${formatLocal(tsOverride || now, tz)}.`);
  }

  // New schema path: handleClock already emits facts in your updated handleClock.
  const out = await handleClock(
    { owner_id: ownerId, user_id: forced, tz, source_msg_id: stableMsgId, meta: { job_name: jobName || null } },
    { action: 'out', at: tsOverride || now.toISOString() }
  );
  return twiml(res, out?.text || '✅ Forced clock-out recorded.');
}


const state = await getCurrentState(ownerId, target);

// ✅ IMPORTANT:
// - Legacy path emits facts via emitTimeclockFact (wrapper)
// - New schema path emits facts INSIDE handleClock
// Therefore: NEVER emitTimeclockFact after handleClock

if (resolvedType === 'clock_in') {
  if (canLegacyWrite) {
    const latest = typeof pg.getLatestTimeEvent === 'function' ? await pg.getLatestTimeEvent(ownerId, target) : null;
    const latestType = String(latest?.type || '').toLowerCase();
    if (!tsOverride && latest && IN_TYPES.has(latestType)) {
      const when = latest?.timestamp ? formatLocal(latest.timestamp, tz) : 'earlier';
      return twiml(res, `${target} is already clocked in since ${when}. Reply "force clock in ${target}" to override.`);
    }

    await pg.logTimeEntryWithJob(ownerId, target, 'clock_in', tsOverride || now, jobName, tz, {
      requester_id: paUserId,
      source_msg_id: stableMsgId
    });

    await emitTimeclockFact({
      ownerId,
      actorKey: paUserId,
      sourceMsgId: stableMsgId,
      resolvedType,
      target,
      jobName,
      tsIso: (tsOverride || now).toISOString ? (tsOverride || now).toISOString() : String(tsOverride || now)
    });

    return twiml(res, `✅ ${target} is clocked in at ${formatLocal(tsOverride || now, tz)}`);
  }

  // New schema path: handleClock emits fact itself ✅
  const out = await handleClock(
    { owner_id: ownerId, user_id: target, tz, source_msg_id: stableMsgId, meta: { job_name: jobName || null } },
    { action: 'in', at: tsOverride || now.toISOString() }
  );

  return twiml(res, out?.text || `✅ ${target} clocked in.`);
}

if (resolvedType === 'clock_out') {
  if (canLegacyWrite) {
    const latest = typeof pg.getLatestTimeEvent === 'function' ? await pg.getLatestTimeEvent(ownerId, target) : null;
    const latestType = String(latest?.type || '').toLowerCase();
    if (!tsOverride && latest && OUT_TYPES.has(latestType)) {
      const when = latest?.timestamp ? formatLocal(latest.timestamp, tz) : 'earlier';
      return twiml(res, `${target} is already clocked out since ${when}. (Use "force clock out ${target}" to override.)`);
    }

    await pg.logTimeEntryWithJob(ownerId, target, 'clock_out', tsOverride || now, jobName, tz, {
      requester_id: paUserId,
      source_msg_id: stableMsgId
    });

    await emitTimeclockFact({
      ownerId,
      actorKey: paUserId,
      sourceMsgId: stableMsgId,
      resolvedType,
      target,
      jobName,
      tsIso: (tsOverride || now).toISOString ? (tsOverride || now).toISOString() : String(tsOverride || now)
    });

    return twiml(res, `✅ ${target} is clocked out at ${formatLocal(tsOverride || now, tz)}`);
  }

  // New schema path: handleClock emits fact itself ✅
  const out = await handleClock(
    { owner_id: ownerId, user_id: target, tz, source_msg_id: stableMsgId, meta: { job_name: jobName || null } },
    { action: 'out', at: tsOverride || now.toISOString() }
  );

  return twiml(res, out?.text || `✅ ${target} clocked out.`);
}

if (resolvedType === 'break_start') {
  if (!state.hasOpenShift) return twiml(res, `Can't start a break — no open shift for ${target}.`);
  if (!tsOverride && state.openBreak) return twiml(res, `${target} is already on break.`);

  if (canLegacyWrite) {
    await pg.logTimeEntryWithJob(ownerId, target, 'break_start', tsOverride || now, jobName, tz, {
      requester_id: paUserId,
      source_msg_id: stableMsgId
    });

    await emitTimeclockFact({
      ownerId,
      actorKey: paUserId,
      sourceMsgId: stableMsgId,
      resolvedType,
      target,
      jobName,
      tsIso: (tsOverride || now).toISOString ? (tsOverride || now).toISOString() : String(tsOverride || now)
    });

    return twiml(res, `⏸️ Break started for ${target} at ${formatLocal(tsOverride || now, tz)}.`);
  }

  // New schema path: handleClock emits fact itself ✅
  const out = await handleClock(
    { owner_id: ownerId, user_id: target, tz, source_msg_id: stableMsgId, meta: { job_name: jobName || null } },
    { action: 'break_start', at: tsOverride || now.toISOString() }
  );

  return twiml(res, out?.text || `⏸️ Break started for ${target}.`);
}

if (resolvedType === 'break_stop') {
  if (!state.hasOpenShift) return twiml(res, `Can't end break — no open shift for ${target}.`);
  if (!tsOverride && !state.openBreak) return twiml(res, `No active break for ${target}.`);

  if (canLegacyWrite) {
    await pg.logTimeEntryWithJob(ownerId, target, 'break_stop', tsOverride || now, jobName, tz, {
      requester_id: paUserId,
      source_msg_id: stableMsgId
    });

    await emitTimeclockFact({
      ownerId,
      actorKey: paUserId,
      sourceMsgId: stableMsgId,
      resolvedType,
      target,
      jobName,
      tsIso: (tsOverride || now).toISOString ? (tsOverride || now).toISOString() : String(tsOverride || now)
    });

    return twiml(res, `▶️ Break ended for ${target} at ${formatLocal(tsOverride || now, tz)}.`);
  }

  // New schema path: handleClock emits fact itself ✅
  const out = await handleClock(
    { owner_id: ownerId, user_id: target, tz, source_msg_id: stableMsgId, meta: { job_name: jobName || null } },
    { action: 'break_stop', at: tsOverride || now.toISOString() }
  );

  return twiml(res, out?.text || `▶️ Break ended for ${target}.`);
}

if (resolvedType === 'drive_start') {
  if (!state.hasOpenShift) return twiml(res, `Can't start drive — no open shift for ${target}.`);
  if (!tsOverride && state.openDrive) return twiml(res, `${target} is already driving.`);

  if (canLegacyWrite) {
    await pg.logTimeEntryWithJob(ownerId, target, 'drive_start', tsOverride || now, jobName, tz, {
      requester_id: paUserId,
      source_msg_id: stableMsgId
    });

    await emitTimeclockFact({
      ownerId,
      actorKey: paUserId,
      sourceMsgId: stableMsgId,
      resolvedType,
      target,
      jobName,
      tsIso: (tsOverride || now).toISOString ? (tsOverride || now).toISOString() : String(tsOverride || now)
    });

    return twiml(res, `🚚 Drive started for ${target} at ${formatLocal(tsOverride || now, tz)}.`);
  }

  // New schema path: handleClock emits fact itself ✅
  const out = await handleClock(
    { owner_id: ownerId, user_id: target, tz, source_msg_id: stableMsgId, meta: { job_name: jobName || null } },
    { action: 'drive_start', at: tsOverride || now.toISOString() }
  );

  return twiml(res, out?.text || `🚚 Drive started for ${target}.`);
}

if (resolvedType === 'drive_stop') {
  if (!state.hasOpenShift) return twiml(res, `Can't stop drive — no open shift for ${target}.`);
  if (!tsOverride && !state.openDrive) return twiml(res, `No active drive for ${target}.`);

  if (canLegacyWrite) {
    await pg.logTimeEntryWithJob(ownerId, target, 'drive_stop', tsOverride || now, jobName, tz, {
      requester_id: paUserId,
      source_msg_id: stableMsgId
    });

    await emitTimeclockFact({
      ownerId,
      actorKey: paUserId,
      sourceMsgId: stableMsgId,
      resolvedType,
      target,
      jobName,
      tsIso: (tsOverride || now).toISOString ? (tsOverride || now).toISOString() : String(tsOverride || now)
    });

    return twiml(res, `🅿️ Drive stopped for ${target} at ${formatLocal(tsOverride || now, tz)}.`);
  }

  // New schema path: handleClock emits fact itself ✅
  const out = await handleClock(
    { owner_id: ownerId, user_id: target, tz, source_msg_id: stableMsgId, meta: { job_name: jobName || null } },
    { action: 'drive_stop', at: tsOverride || now.toISOString() }
  );

  return twiml(res, out?.text || `🅿️ Drive stopped for ${target}.`);
}

    if (isUndo) {
  const shape = await detectTimeEntriesShape();

  if (shape === 'legacy') {
    const del = await pg.query(
      `DELETE FROM public.time_entries
         WHERE id = (
           SELECT id FROM public.time_entries
            WHERE owner_id=$1 AND lower(employee_name)=lower($2)
            ORDER BY timestamp DESC
            LIMIT 1
         )
         RETURNING id, type, timestamp`,
      [String(ownerId || '').trim(), target]
    );

    if (!del.rowCount) return twiml(res, `Nothing to undo for ${target}.`);

    const deletedType = String(del.rows[0].type || '').trim() || 'unknown';
    const deletedAt = del.rows[0].timestamp ? new Date(del.rows[0].timestamp).toISOString() : null;

    // ✅ Brain v0: emit undo fact (best-effort, never blocks UX)
    try {
      const sid = String(stableMsgId || 'no_msg');
      await pg.insertFactEvent({
        owner_id: String(ownerId || '').trim(),
        actor_key: String(paUserId || '').trim(),

        event_type: 'timeclock.undone',
        entity_type: 'time_entry',
        entity_id: del.rows[0].id != null ? String(del.rows[0].id) : null,
        entity_no: null,

        occurred_at: new Date().toISOString(),
        source_msg_id: stableMsgId || null,
        source_kind: 'whatsapp_text',

        event_payload: {
          shape: 'legacy',
          undone_target: String(target || '').trim() || null,
          deleted_type: deletedType,
          deleted_at: deletedAt
        },

        dedupe_key: `timeclock.undone:${sid}:legacy:${String(del.rows[0].id || deletedAt || 'x')}`
      });
    } catch (e) {
      console.warn('[FACT_EVENT] timeclock.undone insert failed (ignored):', e?.message);
    }

    const typeHuman = deletedType.replace(/_/g, ' ');
    const atHuman = del.rows[0].timestamp ? formatLocal(del.rows[0].timestamp, tz) : 'recently';
    return twiml(res, `Undid ${typeHuman} at ${atHuman} for ${target}.`);
  }

  if (shape === 'new') {
    const del = await pg.query(
      `DELETE FROM public.time_entries
         WHERE id = (
           SELECT id FROM public.time_entries
            WHERE owner_id=$1 AND user_id=$2
            ORDER BY coalesce(start_at_utc, created_at) DESC
            LIMIT 1
         )
         RETURNING id, kind, start_at_utc, created_at`,
      [String(ownerId || '').trim(), String(target || '').trim()]
    );

    if (!del.rowCount) return twiml(res, `Nothing to undo for ${target}.`);

    const deletedKind = String(del.rows[0].kind || '').trim() || 'entry';
    const deletedAtIso = del.rows[0].start_at_utc
      ? new Date(del.rows[0].start_at_utc).toISOString()
      : (del.rows[0].created_at ? new Date(del.rows[0].created_at).toISOString() : null);

    // ✅ Brain v0: emit undo fact (best-effort, never blocks UX)
    try {
      const sid = String(stableMsgId || 'no_msg');
      await pg.insertFactEvent({
        owner_id: String(ownerId || '').trim(),
        actor_key: String(paUserId || '').trim(),

        event_type: 'timeclock.undone',
        entity_type: 'time_entry',
        entity_id: del.rows[0].id != null ? String(del.rows[0].id) : null,
        entity_no: null,

        occurred_at: new Date().toISOString(),
        source_msg_id: stableMsgId || null,
        source_kind: 'whatsapp_text',

        event_payload: {
          shape: 'new',
          undone_target: String(target || '').trim() || null,
          deleted_kind: deletedKind,
          deleted_at: deletedAtIso
        },

        dedupe_key: `timeclock.undone:${sid}:new:${String(del.rows[0].id || deletedAtIso || 'x')}`
      });
    } catch (e) {
      console.warn('[FACT_EVENT] timeclock.undone insert failed (ignored):', e?.message);
    }

    const atHuman = del.rows[0].start_at_utc ? formatLocal(del.rows[0].start_at_utc, tz) : 'recently';
    return twiml(res, `Undid ${deletedKind} at ${atHuman} for ${target}.`);
  }

  return twiml(res, `Undo isn't available until time_entries schema is recognized.`);
}

    return false;
  } catch (e) {
    console.error('[timeclock] error:', e?.message, { code: e?.code, detail: e?.detail });
    return twiml(res, 'Timeclock error. Try again.');
  } finally {
    // ✅ prefer request-scoped release (matches your middleware/lock keying)
    try { res?.req?.releaseLock?.(); } catch {}
  }
}

module.exports = { handleTimeclock, handleClock };
