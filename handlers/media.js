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
  // ⬇️ Optional: if your Postgres layer exposes an open-state probe, we'll use it.
  // Prefer these names; we check existence at runtime:
  // getOpenTimeState(ownerId, employeeName) → { on_shift, on_break, on_drive, last_shift_started_at, last_break_started_at, last_drive_started_at }
  // getCurrentPunchState(ownerId, employeeName) → similar shape (compat)
  getOpenTimeState,
  getCurrentPunchState
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

function hoursDecToHM(dec) {
  const h = Math.floor(dec);
  const m = Math.round((dec - h) * 60);
  return { h, m };
}

// ---------- NEW: fetch open-state if the service provides it ----------
async function fetchOpenState(ownerId, employeeName) {
  try {
    if (typeof getOpenTimeState === 'function') {
      return await getOpenTimeState(ownerId, employeeName);
    }
    if (typeof getCurrentPunchState === 'function') {
      return await getCurrentPunchState(ownerId, employeeName);
    }
  } catch (e) {
    console.warn('[OPENSTATE] probe failed:', e.message);
  }
  return null; // gracefully degrade if unavailable
}

// ---------- NEW: conversational enforcement for overlapping states ----------
function humanWhen(ts, tz) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const day = d.toLocaleDateString('en-CA', { timeZone: tz, month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    return `${day} at ${time}`;
  } catch {
    return '';
  }
}

function blockMsg(kind, name, openStartedAt, tz) {
  const when = humanWhen(openStartedAt, tz);
  const tail = when ? ` (started ${when})` : '';
  switch (kind) {
    case 'shift_open':
      return `I can’t clock ${name} in until they clock out of the previous shift${tail}. Say “clock out ${name}” when they’re done.`;
    case 'shift_closed':
      return `${name} isn’t currently clocked in. Want me to clock them in? Try “clock in ${name}”.`;
    case 'break_open':
      return `Looks like ${name} is already on a break${tail}. Say “end break for ${name}” first.`;
    case 'break_closed':
      return `${name} isn’t on a break. You can say “start break for ${name}” to begin one.`;
    case 'drive_open':
      return `${name} is already tracking drive time${tail}. Say “drive end for ${name}” first.`;
    case 'drive_closed':
      return `${name} isn’t currently tracking drive time. Say “drive start for ${name}” to begin.`;
    default:
      return `That action can’t be completed right now for ${name}.`;
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

    const label = typeof friendlyTypeLabel === 'function'
      ? friendlyTypeLabel(type)
      : (type === 'time_entry' ? 'time entry' : type === 'hours_inquiry' ? 'hours inquiry' : String(type || 'entry').replace('_',' '));

    if (mediaUrl && mediaType) {
      // New media → clear any old pending state and process the new file
      await deletePendingTransactionState(from);

    } else if (type != null) {
      if (isYes) {
        if (type === 'expense' && pendingState.pendingExpense) {
          const data = pendingState.pendingExpense;
          await appendToUserSpreadsheet(ownerId, [
            data.date, data.item, data.amount, data.store,
            (await getActiveJob(ownerId)) || 'Uncategorized',
            'expense', data.category, data.mediaUrl || mediaUrl, userProfile.name || 'Unknown',
          ]);
          reply = `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} (Category: ${data.category})`;

        } else if (type === 'revenue' && pendingState.pendingRevenue) {
          const data = pendingState.pendingRevenue;
          await appendToUserSpreadsheet(ownerId, [
            data.date, data.description, data.amount, data.source,
            (await getActiveJob(ownerId)) || 'Uncategorized',
            'revenue', data.category, data.mediaUrl || mediaUrl, userProfile.name || 'Unknown',
          ]);
          reply = `✅ Revenue logged: ${data.amount} from ${data.source} (Category: ${data.category})`;

        } else if (type === 'time_entry' && pendingState.pendingTimeEntry) {
          const { employeeName, type: entryType, timestamp, job } = pendingState.pendingTimeEntry;
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
            ownerId, person: name, period, tz, now: new Date()
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


    /// ---------- Build text from media ----------
let extractedText = String(input || '').trim();

if (validAudioTypes.some(t => mediaType && mediaType.toLowerCase().startsWith(t.split(';')[0]))) {
  try {
    const resp = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
    });
    const audioBuf = Buffer.from(resp.data);
    console.log('[DEBUG] audio bytes:', audioBuf?.length, 'mime:', mediaType);

    // First pass (whatever your transcribeAudio currently prefers — typically Google first)
    let primary = await transcribeAudio(audioBuf, mediaType);
    primary = (primary || '').trim();
    console.log('[DEBUG] Primary transcript length:', primary.length, 'text:', JSON.stringify(primary));

    // Heuristics for “bad/too-short” outcomes (e.g., just "now.")
    const looksBad =
      !primary ||
      primary.replace(/[^\p{L}\p{N}]+/gu, '').length < 3 ||          // too few alphanum chars
      /^now\.?$/i.test(primary) ||                                   // only "now"
      primary.length < 8;                                            // very short

    // Second pass: force Whisper (if your service supports options; if not, it’ll be ignored harmlessly)
    let secondary = null;
    if (looksBad) {
      try {
        secondary = await transcribeAudio(audioBuf, mediaType, { forceEngine: 'whisper' });
        secondary = (secondary || '').trim();
        console.log('[DEBUG] Secondary(Whisper) transcript length:', secondary.length, 'text:', JSON.stringify(secondary));
      } catch (e2) {
        console.warn('[DEBUG] Whisper secondary transcription failed:', e2.message);
      }
    }

    // Pick the better of the two: prefer the longer, non-"now" string
    let chosen = primary;
    if (secondary) {
      const priBadScore = /^now\.?$/i.test(primary) ? 1 : 0;
      const secBadScore = /^now\.?$/i.test(secondary) ? 1 : 0;
      if (secondary.length > primary.length || (secBadScore < priBadScore)) {
        chosen = secondary;
      }
    }

    extractedText = (chosen || extractedText || '').trim();
    console.log('[DEBUG] Chosen transcript length:', extractedText.length, 'text:', JSON.stringify(extractedText));
  } catch (e) {
    console.error('[ERROR] audio download/transcribe failed:', e.message);
  }

  if (!extractedText) {
    return twiml(`⚠️ I couldn’t understand the audio. Try again, or text me the details like "Justin hours week" or "expense $12 coffee".`);
  }
} else if (validImageTypes.includes(mediaType)) {
  const { text } = await extractTextFromImage(mediaUrl);
  console.log('[DEBUG] OCR text length:', (text || '').length);
  extractedText = (text || extractedText || '').trim();
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
      const { employeeName, type, timestamp } = result.data;
      const tz = getUserTz(userProfile);
      const activeJob = await getActiveJob(ownerId);
      const jobForLog = activeJob !== 'Uncategorized' ? activeJob : null;

      // ⬇️ NEW: enforce open/close rules if we can fetch state
      const state = await fetchOpenState(ownerId, employeeName);

      if (state) {
        if (type === 'punch_in' && state.on_shift) {
          return twiml(blockMsg('shift_open', employeeName, state.last_shift_started_at, tz));
        }
        if (type === 'punch_out' && !state.on_shift) {
          return twiml(blockMsg('shift_closed', employeeName, null, tz));
        }

        // Break is unified (covers “lunch” too, mapping -> break_*)
        if (type === 'break_start' && !state.on_shift) {
          return twiml(`I can’t start a break for ${employeeName} until they’re clocked in. Try “clock in ${employeeName}”.`);
        }
        if (type === 'break_start' && state.on_break) {
          return twiml(blockMsg('break_open', employeeName, state.last_break_started_at, tz));
        }
        if (type === 'break_end' && !state.on_break) {
          return twiml(blockMsg('break_closed', employeeName, null, tz));
        }

        // Drive rules (if you track drive separately)
        if (type === 'drive_start' && state.on_drive) {
          return twiml(blockMsg('drive_open', employeeName, state.last_drive_started_at, tz));
        }
        if (type === 'drive_end' && !state.on_drive) {
          return twiml(blockMsg('drive_closed', employeeName, null, tz));
        }
      }

      // If we reach here, proceed with logging
      await logTimeEntry(ownerId, employeeName, type, timestamp, jobForLog);

      const humanTime = fmtLocal(timestamp, tz);
      let base = `✅ ${type.replace('_', ' ')} logged for ${employeeName} at ${humanTime}${jobForLog ? ` on ${jobForLog}` : ''}.`;

      // Only add a "today total" for punch_out
      if (type === 'punch_out') {
        try {
          const { message } = await generateTimesheet({
            ownerId,
            person: employeeName,
            period: 'day',
            tz,
            now: new Date()
          });
          const firstLine = String(message || '').split('\n')[0] || '';
          const mm = firstLine.match(/\bworked\s+([\d.]+)\s+hours\b/i);
          if (mm) {
            const dec = parseFloat(mm[1]);
            if (isFinite(dec)) {
              const { h, m } = hoursDecToHM(dec);
              base += ` Total hours worked today ${h} ${h === 1 ? 'hour' : 'hours'}${m ? ` ${m} minutes` : ''}.`;
            }
          }
        } catch (e) {
          console.warn('[MEDIA] day total fetch failed:', e.message);
        }
      }

      reply = base;
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
