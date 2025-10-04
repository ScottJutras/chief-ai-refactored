// handlers/media.js
const axios = require('axios');
const { parseMediaText } = require('../services/mediaParser');
const { extractTextFromImage } = require('../utils/visionService');
const { transcribeAudio } = require('../utils/transcriptionService');

const {
  logTimeEntry,
  getActiveJob,
  appendToUserSpreadsheet,
  generateTimesheet,

  // ⬇️ OPTIONAL: if you add these in your Postgres service, the guardrails become hard-enforced.
  // getOpenShiftFor, getOpenBreakFor
} = require('../services/postgres');

const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState
} = require('../utils/stateManager');

function twiml(text) {
  return `<Response><Message>${text}</Message></Response>`;
}

function getUserTz(userProfile) {
  return (
    userProfile?.timezone ||
    userProfile?.tz ||
    userProfile?.time_zone ||
    'America/Toronto'
  );
}

function fmtLocal(tsIso, tz) {
  try {
    return new Date(tsIso).toLocaleString('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(tsIso).toLocaleString();
  }
}

function friendlyTypeLabel(type) {
  if (!type) return 'entry';
  if (type === 'time_entry') return 'time entry';
  if (type === 'hours_inquiry') return 'hours inquiry';
  return String(type).replace('_', ' ');
}

// ⬇️ NEW: helpers for timeclock guardrails
function isStartAction(entryType) {
  return entryType === 'punch_in' || entryType === 'break_start' || entryType === 'drive_start';
}
function isEndAction(entryType) {
  return entryType === 'punch_out' || entryType === 'break_end' || entryType === 'drive_end';
}
function conflictMessage(name, entryType, openWhat) {
  // openWhat: 'shift' | 'break' | 'drive'
  if (entryType === 'punch_in' && openWhat === 'shift') {
    return `I can’t clock ${name} in until they’re clocked out of their previous shift. Try “clock out ${name}” first.`;
  }
  if (entryType === 'break_start' && openWhat === 'break') {
    return `Looks like ${name} is already on a break. Say “end break for ${name}” to wrap it up.`;
  }
  if (entryType === 'drive_start' && openWhat === 'drive') {
    return `${name} already has a drive session running. Try “end drive for ${name}” first.`;
  }
  if (entryType === 'punch_out' && openWhat !== 'shift') {
    return `I couldn’t find an active shift for ${name} to clock out from. Try “clock in ${name}” first.`;
  }
  if (entryType === 'break_end' && openWhat !== 'break') {
    return `There’s no active break for ${name}. Say “start break for ${name}” if they’re stepping away.`;
  }
  if (entryType === 'drive_end' && openWhat !== 'drive') {
    return `There’s no active drive session for ${name}. Say “start drive for ${name}” to begin one.`;
  }
  return null;
}

// ⬇️ NEW: soft guard that checks for open items if your Postgres service exposes helpers.
// If not, this becomes a no-op and everything else still works.
async function ensureAllowedTransition(ownerId, employeeName, entryType) {
  try {
    const pg = require('../services/postgres') || {};
    const has = (fn) => typeof fn === 'function';

    // When starting, ensure there isn't already an open of the same “lane”
    if (isStartAction(entryType)) {
      if (entryType === 'punch_in' && has(pg.getOpenShiftFor)) {
        const openShift = await pg.getOpenShiftFor(ownerId, employeeName);
        if (openShift) return conflictMessage(employeeName, 'punch_in', 'shift');
      }
      if (entryType === 'break_start' && has(pg.getOpenBreakFor)) {
        const openBreak = await pg.getOpenBreakFor(ownerId, employeeName);
        if (openBreak) return conflictMessage(employeeName, 'break_start', 'break');
      }
      if (entryType === 'drive_start' && has(pg.getOpenDriveFor)) {
        const openDrive = await pg.getOpenDriveFor(ownerId, employeeName);
        if (openDrive) return conflictMessage(employeeName, 'drive_start', 'drive');
      }
    }

    // When ending, ensure there IS an open to end
    if (isEndAction(entryType)) {
      if (entryType === 'punch_out' && has(pg.getOpenShiftFor)) {
        const openShift = await pg.getOpenShiftFor(ownerId, employeeName);
        if (!openShift) return conflictMessage(employeeName, 'punch_out', 'none');
      }
      if (entryType === 'break_end' && has(pg.getOpenBreakFor)) {
        const openBreak = await pg.getOpenBreakFor(ownerId, employeeName);
        if (!openBreak) return conflictMessage(employeeName, 'break_end', 'none');
      }
      if (entryType === 'drive_end' && has(pg.getOpenDriveFor)) {
        const openDrive = await pg.getOpenDriveFor(ownerId, employeeName);
        if (!openDrive) return conflictMessage(employeeName, 'drive_end', 'none');
      }
    }

    return null; // allowed
  } catch {
    return null; // if helpers aren’t present or error, don’t block
  }
}

async function handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType) {
  let reply;
  try {
    console.log(`[DEBUG] Processing media from ${from}: type=${mediaType}, url=${mediaUrl}, input=${input || ''}`);

    const validImageTypes = ['image/jpeg', 'image/png'];
    const validAudioTypes = [
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/ogg; codecs=opus',
      'audio/webm',
      'audio/webm; codecs=opus'
    ];

    // --------- Basic media guard ---------
    if (
      !validImageTypes.includes(mediaType) &&
      !validAudioTypes.some(t => (mediaType || '').toLowerCase().startsWith(t.split(';')[0]))
    ) {
      reply = `⚠️ Unsupported media type: ${mediaType}. Please send a JPEG/PNG image or MP3/WAV/OGG audio.`;
      return twiml(reply);
    }

    // ---------- Pending confirmation flow (do not block if NEW MEDIA arrived) ----------
    {
      const pendingState = await getPendingTransactionState(from);
      if (pendingState?.pendingMedia) {
        const { type } = pendingState.pendingMedia; // can be null (unknown) or a string
        const rawInput = String(input || '');
        const lcInput = rawInput.toLowerCase().trim().replace(/[.!?]$/,'');
        const isYes = lcInput === 'yes' || lcInput === 'y';
        const isNo  = lcInput === 'no'  || lcInput === 'n' || lcInput === 'cancel';

        const label = friendlyTypeLabel(type);

        if (mediaUrl && mediaType) {
          await deletePendingTransactionState(from);

        } else if (type != null) {
          if (isYes) {
            if (type === 'expense' && pendingState.pendingExpense) {
              const data = pendingState.pendingExpense;
              await appendToUserSpreadsheet(ownerId, [
                data.date,
                data.item,
                data.amount,
                data.store,
                (await getActiveJob(ownerId)) || 'Uncategorized',
                'expense',
                data.category,
                data.mediaUrl || mediaUrl,
                userProfile.name || 'Unknown',
              ]);
              reply = `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} (Category: ${data.category})`;

            } else if (type === 'revenue' && pendingState.pendingRevenue) {
              const data = pendingState.pendingRevenue;
              await appendToUserSpreadsheet(ownerId, [
                data.date,
                data.description,
                data.amount,
                data.source,
                (await getActiveJob(ownerId)) || 'Uncategorized',
                'revenue',
                data.category,
                data.mediaUrl || mediaUrl,
                userProfile.name || 'Unknown',
              ]);
              reply = `✅ Revenue logged: ${data.amount} from ${data.source} (Category: ${data.category})`;

            } else if (type === 'time_entry' && pendingState.pendingTimeEntry) {
              const { employeeName, type: entryType, timestamp, job } = pendingState.pendingTimeEntry;

              // Guard: prevent illegal transitions (if helpers exist)
              const deny = await ensureAllowedTransition(ownerId, employeeName, entryType);
              if (deny) {
                await deletePendingTransactionState(from);
                return twiml(`⚠️ ${deny}`);
              }

              await logTimeEntry(ownerId, employeeName, entryType, timestamp, job);
              const tz = getUserTz(userProfile);
              reply = `✅ ${entryType.replace('_', ' ')} logged for ${employeeName} at ${fmtLocal(timestamp, tz)}${job ? ` on ${job}` : ''}`;

            } else if (type === 'hours_inquiry') {
              reply = `Please specify: today, this week, or this month.`;

            } else {
              reply = `Hmm, I lost the details for that ${label}. Please resend.`;
            }
            await deletePendingTransactionState(from);
            return twiml(reply);

          } else if (isNo) {
            reply = `❌ ${label} cancelled.`;
            await deletePendingTransactionState(from);
            return twiml(reply);

          } else if (lcInput === 'edit') {
            reply = `Please resend the ${label} details.`;
            await deletePendingTransactionState(from);
            return twiml(reply);

          } else if (type === 'hours_inquiry') {
            let periodWord = lcInput.match(/\b(today|day|this\s+week|week|this\s+month|month|now)\b/i)?.[1]?.toLowerCase();
            if (periodWord) {
              if (periodWord === 'now') periodWord = 'today';
              if (periodWord === 'this week') periodWord = 'week';
              if (periodWord === 'this month') periodWord = 'month';
              const period = periodWord === 'today' ? 'day' : periodWord;
              const tz = getUserTz(userProfile);
              const name = pendingState.pendingHours?.employeeName || userProfile?.name || '';
              const { message } = await generateTimesheet({
                ownerId,
                person: name,
                period,
                tz,
                now: new Date()
              });
              await deletePendingTransactionState(from);
              return twiml(message);
            }
            return twiml(`Got it. Do you want **today**, **this week**, or **this month** for ${pendingState.pendingHours?.employeeName || 'them'}?`);
          } else {
            return twiml(`⚠️ Please reply with 'yes', 'no', or 'edit' to confirm or cancel the ${label}.`);
          }

        } else if (type == null && !mediaUrl) {
          return twiml(`Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`);
        }
      }
    }

    // ---------- Build text from media ----------
    let extractedText = String(input || '').trim();

    if (validAudioTypes.some(t => mediaType && mediaType.toLowerCase().startsWith(t.split(';')[0]))) {
      try {
        const resp = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
        });
        const audioBuf = Buffer.from(resp.data);
        console.log('[DEBUG] audio bytes:', audioBuf?.length, 'mime:', mediaType);
        const transcript = await transcribeAudio(audioBuf, mediaType);
        const len = transcript ? transcript.length : 0;
        console.log(`[DEBUG] Transcription${transcript ? '' : ' (none)'}${len ? ' length: ' + len : ''}`);
        extractedText = (transcript || extractedText || '').trim();
      } catch (e) {
        console.error('[ERROR] audio download/transcribe failed:', e.message);
      }

      // ⬇️ NEW: salvage “Now.” one-word transcriptions from noise
      if (/^now\.?$/i.test(extractedText)) {
        // If it’s literally just “now”, ask a nudge that guides the user into a full phrase.
        // (We keep this very light so it doesn’t get in the way when STT works.)
        return twiml(`Heard “now”. If you’re clocking someone, say “clock in Justin now” or “punch out Justin”.`);
      }

      if (!extractedText) {
        return twiml(`⚠️ I couldn’t understand the audio. Try again, or text me the details like "Justin hours week" or "expense $12 coffee".`);
      }
    } else if (validImageTypes.includes(mediaType)) {
      const { text } = await extractTextFromImage(mediaUrl);
      console.log('[DEBUG] OCR text length:', (text || '').length);
      extractedText = (text || extractedText || '').trim();
    }

    if (!extractedText) {
      const msg = `Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
      await setPendingTransactionState(from, { pendingMedia: { url: mediaUrl, type: null } });
      return twiml(msg);
    }

    // ---------- Parse ----------
    console.log('[DEBUG] parseMediaText called:', { text: extractedText || '(empty)' });
    let result;
    try {
      result = await parseMediaText(extractedText);
    } catch (e) {
      console.error('[ERROR] parseMediaText failed:', e.message);
      const msg = `I couldn’t read that. Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
      await setPendingTransactionState(from, { pendingMedia: { url: mediaUrl, type: null } });
      return twiml(msg);
    }

    // ---------- Handle parse result ----------
    if (result.type === 'hours_inquiry') {
      const name = result.data.employeeName || userProfile?.name || '';
      const tz = getUserTz(userProfile);

      if (result.data.period) {
        const { message } = await generateTimesheet({
          ownerId,
          person: name,
          period: result.data.period, // 'day'|'week'|'month'
          tz,
          now: new Date()
        });
        return twiml(message);
      }

      await setPendingTransactionState(from, {
        pendingMedia: { type: 'hours_inquiry' },
        pendingHours: { employeeName: name }
      });
      return twiml(`Looks like you’re asking about ${name}’s hours. Do you want **today**, **this week**, or **this month**?`);
    }

    if (result.type === 'time_entry') {
      // Voice UX: auto-commit, but add guardrails and only show a summary for punch_out.
      const { employeeName, type, timestamp } = result.data;
      const tz = getUserTz(userProfile);
      const activeJob = await getActiveJob(ownerId);
      const jobForLog = activeJob !== 'Uncategorized' ? activeJob : null;

      // ⬇️ NEW: guard against illegal transitions when helpers exist
      const deny = await ensureAllowedTransition(ownerId, employeeName, type);
      if (deny) {
        return twiml(`⚠️ ${deny}`);
      }

      await logTimeEntry(ownerId, employeeName, type, timestamp, jobForLog);

      let summaryTail = '';
      try {
        if (type === 'punch_out') {
          // Include a quick same-day total at punch-out (what you asked for)
          const { message } = await generateTimesheet({
            ownerId,
            person: employeeName,
            period: 'day',
            tz,
            now: new Date()
          });
          const firstLine = String(message || '').split('\n')[0] || '';
          if (firstLine) summaryTail = `\n${firstLine.replace(/^[^A-Za-z0-9]*/, '')}`;
        }
      } catch (e) {
        console.warn('[MEDIA] timesheet summary failed:', e.message);
      }

      const humanTime = fmtLocal(timestamp, tz);
      reply = `✅ ${type.replace('_', ' ')} logged for ${employeeName} at ${humanTime}${jobForLog ? ` on ${jobForLog}` : ''}.${summaryTail}`;
      return twiml(reply);
    }

    if (result.type === 'expense') {
      const { item, amount, store, date, category } = result.data;
      reply = `Please confirm: Log expense ${amount} for ${item} from ${store} on ${date} (Category: ${category})? Reply 'yes', 'no', or 'edit'.`;
      await setPendingTransactionState(from, {
        pendingMedia: { type: 'expense' },
        pendingExpense: { item, amount, store, date, category, mediaUrl }
      });
      return twiml(reply);
    }

    if (result.type === 'revenue') {
      const { description, amount, source, date, category } = result.data;
      reply = `Please confirm: Log revenue ${amount} from ${source} on ${date} (Category: ${category})? Reply 'yes', 'no', or 'edit'.`;
      await setPendingTransactionState(from, {
        pendingMedia: { type: 'revenue' },
        pendingRevenue: { description, amount, source, date, category, mediaUrl }
      });
      return twiml(reply);
    }

    // Fallback
    reply = `Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
    await setPendingTransactionState(from, { pendingMedia: { url: mediaUrl, type: null } });
    return twiml(reply);

  } catch (error) {
    console.error(`[ERROR] handleMedia failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process media: ${error.message}`;
    return twiml(reply);
  }
}

module.exports = { handleMedia };
