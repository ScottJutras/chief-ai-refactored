// handlers/commands/job.js
// ---------------------------------------------------------------
// Job commands – create, set active, start/activate, pause/resume/finish, list,
// move-last-log, summary. All DB calls via services/postgres.
// ---------------------------------------------------------------
const { formatInTimeZone } = require('date-fns-tz');
const pg = require('../../services/postgres');
const { releaseLock } = require('../../middleware/lock');
const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState,
} = require('../../utils/stateManager');
const { sendQuickReply, sendMessage } = require('../../services/twilio');

const TZ_DEFAULT = 'America/Toronto';
const RESP = (text) => `<Response><Message>${text}</Message></Response>`;

/** Parse job name for “start/activate job …” style commands */
function parseStartActivateName(text) {
  const s = String(text || '').trim();
  const patterns = [
    /^start\s+job\s+(.+)$/i,
    /^activate\s+job\s+(.+)$/i,
    /^set\s+job\s+(.+?)\s+(?:active|on)$/i,
    /^job\s+start\s+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) return m[1].trim();
  }
  // Gentle fallback: message contains "job" and starts with "start"
  if (/^\s*start\s+/i.test(s) && /job/i.test(s)) {
    const m2 = s.match(/job\s+(.+)/i);
    if (m2 && m2[1]) return m2[1].trim();
  }
  return null;
}

async function handleJob(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lc = String(text || '').toLowerCase().trim();
  const state = (await getPendingTransactionState(from)) || {};
  const zone = userProfile?.tz || TZ_DEFAULT;

  try {
    // -------------------------------------------------
    // 0. START / ACTIVATE JOB <name>
    // (Explicit confirmation reply with ✅ + timestamp)
    // -------------------------------------------------
    {
      const name = parseStartActivateName(text);
      if (name) {
        try {
          const j = await pg.activateJobByName(ownerId, name);
          const when = formatInTimeZone(new Date(), zone, 'yyyy-MM-dd HH:mm:ss');
          await sendMessage(from, `✅ Job started: **${j.name}** (#${j.job_no}) at ${when} ${zone}`);
        } catch (e) {
          console.warn('[job] start/activate failed:', e?.message);
          await sendMessage(from, `Sorry—couldn’t start that job. ${e?.message || ''}`.trim());
        }
        return true;
      }
    }

    // -------------------------------------------------
    // 1. CREATE JOB <name> (with confirmation)
    // -------------------------------------------------
    {
      const m = lc.match(/^create\s+job\s+(.+)$/i);
      if (m) {
        const name = m[1].trim();
        if (!name) {
          res.status(200).type('application/xml').send(RESP(`Please provide a job name.`));
          return true;
        }
        // Store pending create
        state.jobFlow = { action: 'create', name };
        await setPendingTransactionState(from, state);
        await sendQuickReply(
          from,
          `Create job **${name}**? All future entries will go here until you switch.`,
          ['Yes', 'No', 'Rename']
        );
        return true;
      }
    }

    // Pending create confirmation
    if (state.jobFlow?.action === 'create' && state.jobFlow.name) {
      if (/^yes$/i.test(lc)) {
        const name = state.jobFlow.name;
        delete state.jobFlow;
        try {
          const job = await pg.createJob(ownerId, name);
          await pg.setActiveJob(ownerId, name);
          state.lastCreatedJobName = name;
          state.lastCreatedJobNo = job.job_no;
          await setPendingTransactionState(from, state);
          await sendQuickReply(
            from,
            `Job **${name}** (#${job.job_no}) created and set active.`,
            ['Clock in', 'Add expense', 'Finish job']
          );
        } catch (e) {
          console.warn('[job] create failed:', e?.message);
          await sendMessage(from, `Couldn’t create job “${name}”.`);
        }
        return true;
      }
      if (/^no$/i.test(lc)) {
        delete state.jobFlow;
        await setPendingTransactionState(from, state);
        await sendMessage(from, `Job creation cancelled.`);
        return true;
      }
      if (/^rename$/i.test(lc)) {
        state.jobFlow.expectRename = true;
        await setPendingTransactionState(from, state);
        await sendMessage(from, `What should the job be called?`);
        return true;
      }
      if (state.jobFlow.expectRename) {
        const newName = text.trim();
        if (!newName) {
          await sendMessage(from, `Please provide a name.`);
          return true;
        }
        state.jobFlow.name = newName;
        delete state.jobFlow.expectRename;
        await setPendingTransactionState(from, state);
        await sendQuickReply(
          from,
          `Create job **${newName}**?`,
          ['Yes', 'No']
        );
        return true;
      }
      // Repeat prompt
      await sendQuickReply(
        from,
        `Create job **${state.jobFlow.name}**?`,
        ['Yes', 'No', 'Rename']
      );
      return true;
    }

    // -------------------------------------------------
    // 2. SET ACTIVE JOB <name|#no> (legacy phrasing)
    // -------------------------------------------------
    {
      const m = lc.match(/^(?:set\s+)?active\s+job\s+(.+)$/i);
      if (m) {
        const ident = m[1].trim();
        try {
          const job = await pg.setActiveJob(ownerId, ident);
          await sendMessage(from, `Active job set to **${job.name}** (#${job.job_no}).`);
        } catch (e) {
          console.warn('[job] set-active failed:', e?.message);
          await sendMessage(from, `Couldn’t set active job “${ident}”.`);
        }
        return true;
      }
    }

    // -------------------------------------------------
    // 3. PAUSE / RESUME / FINISH JOB
    // -------------------------------------------------
    {
      const verbMap = { pause: 'pauseJob', resume: 'resumeJob', finish: 'finishJob' };
      for (const [verb, fn] of Object.entries(verbMap)) {
        const m = lc.match(new RegExp(`^${verb}\\s+job\\s+(.+)$`, 'i'));
        if (m) {
          const ident = m[1].trim();
          try {
            const job = await pg[fn](ownerId, ident);
            if (!job) throw new Error('not found');
            const action = verb.charAt(0).toUpperCase() + verb.slice(1) + 'd';
            await sendMessage(from, `${action} job **${job.name}**.`);
          } catch (e) {
            console.warn(`[job] ${verb} failed:`, e?.message);
            await sendMessage(from, `Couldn’t ${verb} job “${ident}”.`);
          }
          return true;
        }
      }
    }

    // -------------------------------------------------
    // 4. LIST OPEN JOBS
    // -------------------------------------------------
    if (/^list\s+jobs?$/i.test(lc)) {
      try {
        const jobs = await pg.listOpenJobs(ownerId, 5);
        if (!jobs.length) {
          res.status(200).type('application/xml').send(RESP(`No open jobs.`));
          return true;
        }
        const lines = jobs.map(j => `• **${j.name}** (#${j.job_no})${j.active ? ' (active)' : ''}`);
        res.status(200).type('application/xml').send(RESP(`Open jobs:\n${lines.join('\n')}`));
        return true;
      } catch (e) {
        console.warn('[job] list failed:', e?.message);
        res.status(200).type('application/xml').send(RESP(`Couldn’t list jobs.`));
        return true;
      }
    }

    // -------------------------------------------------
    // 5. ACTIVE JOB?
    // -------------------------------------------------
    if (/^active\s+job\??$/i.test(lc)) {
      try {
        const name = await pg.getActiveJob(ownerId);
        const msg = name === 'Uncategorized' ? 'No active job set.' : `Active job: **${name}**.`;
        res.status(200).type('application/xml').send(RESP(msg));
        return true;
      } catch (e) {
        console.warn('[job] active? failed:', e?.message);
        res.status(200).type('application/xml').send(RESP(`Couldn’t fetch active job.`));
        return true;
      }
    }

    // -------------------------------------------------
    // 6. MOVE LAST LOG TO <job>
    // -------------------------------------------------
    {
      const m = lc.match(/^move\s+last\s+log\s+to\s+(.+)$/i);
      if (m) {
        const target = m[1].trim();
        try {
          const job = await pg.findJob(ownerId, target);
          if (!job) throw new Error('job not found');
          const employee = userProfile?.name || from;
          const updated = await pg.moveLastEntryToJob(ownerId, employee, job.name);
          if (!updated) throw new Error('no entry');
          res.status(200).type('application/xml').send(RESP(`Last log moved to **${job.name}**.`));
          return true;
        } catch (e) {
          console.warn('[job] move-last failed:', e?.message);
          res.status(200).type('application/xml').send(RESP(`Couldn’t move last log to “${target}”.`));
          return true;
        }
      }
    }

    return false; // fall through
  } catch (e) {
    console.error('[job] error:', e?.message);
    res.status(200).type('application/xml').send(RESP(`Job error. Try again.`));
    return true;
  } finally {
    await releaseLock(`lock:${ownerId || from}`);
  }
}

module.exports = handleJob;
