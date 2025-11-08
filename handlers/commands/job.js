// handlers/commands/job.js
// ---------------------------------------------------------------
// Job commands — create, start/activate, set-active, pause/resume/finish,
// list, active?, move-last-log [for <name>].
// All DB calls go through services/postgres.
// ---------------------------------------------------------------
const pg = require('../../services/postgres');
const { formatInTimeZone } = require('date-fns-tz');

const TZ_DEFAULT = 'America/Toronto';
const RESP = (text) => `<Response><Message>${text}</Message></Response>`;

// ---------- parsing helpers ----------
function parseStartActivateName(text) {
  const s = String(text || '').trim();
  const patterns = [
    /^start\s+job\s+(.+)$/i,
    /^activate\s+job\s+(.+)$/i,
    /^job\s+start\s+(.+)$/i,
    /^(?:start|activate)\s+(.+)$/i, // "start Kitchen" (no 'job')
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

// set-active: either "#12" or name
function parseJobIdent(raw) {
  const ident = String(raw || '').trim();
  const m = ident.match(/^#?(\d+)$/);
  if (m) return { jobNo: parseInt(m[1], 10) };
  return { name: ident };
}

// move-last-log: allow optional "for <name>"
function parseMoveLast(textLC) {
  // "move last log to <job> [for <name>]"
  const m = textLC.match(/^move\s+last\s+log\s+to\s+(.+?)(?:\s+for\s+(.+))?$/i);
  if (!m) return null;
  const jobName = (m[1] || '').trim();
  const forName = (m[2] || '').trim();
  return { jobName, forName: forName || null };
}

function tzOf(userProfile, ownerProfile) {
  return userProfile?.tz || ownerProfile?.tz || TZ_DEFAULT;
}

function sendXml(res, text) {
  res.status(200).type('application/xml').send(RESP(text));
  return true;
}

// ---------- small DB helpers (via pg.query) ----------
async function getActiveJobRow(ownerId) {
  const { rows } = await pg.query(
    `SELECT job_no, COALESCE(name, job_name) AS name, active, updated_at
       FROM public.jobs
      WHERE owner_id = $1 AND active = true
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [String(ownerId).replace(/\D/g, '')]
  );
  return rows[0] || null;
}

async function listRecentJobs(ownerId, limit = 5) {
  const { rows } = await pg.query(
    `SELECT job_no, COALESCE(name, job_name) AS name, active
       FROM public.jobs
      WHERE owner_id = $1
      ORDER BY active DESC, updated_at DESC NULLS LAST, created_at DESC
      LIMIT $2`,
    [String(ownerId).replace(/\D/g, ''), limit]
  );
  return rows;
}

async function getJobByNo(owner, jobNo) {
  const { rows } = await pg.query(
    `SELECT job_no, COALESCE(name, job_name) AS name, active
       FROM public.jobs
      WHERE owner_id = $1 AND job_no = $2
      LIMIT 1`,
    [String(owner).replace(/\D/g, ''), jobNo]
  );
  return rows[0] || null;
}

async function activateByJobNo(ownerId, jobNo) {
  const owner = String(ownerId).replace(/\D/g, '');
  await pg.query(
    `UPDATE public.jobs
        SET active = false, updated_at = NOW()
      WHERE owner_id = $1 AND active = true AND job_no <> $2`,
    [owner, jobNo]
  );
  const { rowCount } = await pg.query(
    `UPDATE public.jobs
        SET active = true, updated_at = NOW()
      WHERE owner_id = $1 AND job_no = $2`,
    [owner, jobNo]
  );
  if (!rowCount) throw new Error('not found');
  return getJobByNo(owner, jobNo);
}

async function finishJob(ownerId, ident) {
  const owner = String(ownerId).replace(/\D/g, '');
  if (ident.jobNo) {
    await pg.query(
      `UPDATE public.jobs
          SET active = false, updated_at = NOW(), finished_at = NOW()
        WHERE owner_id = $1 AND job_no = $2`,
      [owner, ident.jobNo]
    );
    return getJobByNo(owner, ident.jobNo);
  } else {
    const j = await pg.ensureJobByName(owner, ident.name);
    await pg.query(
      `UPDATE public.jobs
          SET active = false, updated_at = NOW(), finished_at = NOW()
        WHERE owner_id = $1 AND job_no = $2`,
      [owner, j.job_no]
    );
    return getJobByNo(owner, j.job_no);
  }
}

async function pauseJob(ownerId, ident) {
  const owner = String(ownerId).replace(/\D/g, '');
  if (ident.jobNo) {
    await pg.query(
      `UPDATE public.jobs
          SET active = false, updated_at = NOW()
        WHERE owner_id = $1 AND job_no = $2`,
      [owner, ident.jobNo]
    );
    return getJobByNo(owner, ident.jobNo);
  } else {
    const j = await pg.ensureJobByName(owner, ident.name);
    await pg.query(
      `UPDATE public.jobs
          SET active = false, updated_at = NOW()
        WHERE owner_id = $1 AND job_no = $2`,
      [owner, j.job_no]
    );
    return getJobByNo(owner, j.job_no);
  }
}

async function resumeJob(ownerId, ident) {
  const owner = String(ownerId).replace(/\D/g, '');
  if (ident.jobNo) {
    return activateByJobNo(owner, ident.jobNo);
  } else {
    // reuse your robust activation path
    return pg.activateJobByName(owner, ident.name);
  }
}

async function moveLastEntryToJob(ownerId, employeeName, targetJobName) {
  const owner = String(ownerId).replace(/\D/g, '');
  const target = await pg.ensureJobByName(owner, targetJobName);
  if (!target) throw new Error('target job not found');

  // find last entry for employee
  const { rows } = await pg.query(
    `SELECT id
       FROM public.time_entries
      WHERE owner_id=$1 AND lower(employee_name)=lower($2)
      ORDER BY timestamp DESC
      LIMIT 1`,
    [owner, String(employeeName || '').trim()]
  );
  const last = rows[0];
  if (!last) return { updated: 0, job: target };

  const upd = await pg.query(
    `UPDATE public.time_entries
        SET job_no = $1
      WHERE id = $2`,
    [target.job_no, last.id]
  );
  return { updated: upd.rowCount || 0, job: target };
}

// ---------- main handler ----------
async function handleJob(from, text, userProfile, ownerId, ownerProfile, _isOwner, res) {
  const lc = String(text || '').toLowerCase().trim();
  const zone = tzOf(userProfile, ownerProfile);
  const now  = formatInTimeZone(new Date(), zone, 'yyyy-MM-dd HH:mm:ss');
  const actorId = from;

  try {
    // trace breadcrumb
    console.info('[job] cmd', { ownerId, from, lc, at: now });

    // lightweight rate-limit (fail-open if internal error)
    const limit = await pg.checkTimeEntryLimit(ownerId, actorId, { max: 8, windowSec: 30 });
    if (limit && limit.ok === false) {
      return sendXml(res, 'Too many actions — slow down for a few seconds.');
    }

    // explicit help
    if (/^(job\s+help|help\s+job)$/i.test(lc)) {
      return sendXml(res,
        'Jobs:\n' +
        '• start job <name>\n' +
        '• create job <name>\n' +
        '• set active job <#no|name>\n' +
        '• pause/resume/finish job <#no|name>\n' +
        '• list jobs\n' +
        '• active job?\n' +
        '• move last log to <job> [for <name>]');
    }

    // 0) START / ACTIVATE JOB <name>
    {
      const name = parseStartActivateName(text);
      if (name) {
        try {
          const j = await pg.activateJobByName(ownerId, name);
          console.info('[job] activated', { ownerId, job_no: j.job_no, name: j.name });
          return sendXml(res, `✅ Job started: **${j.name}** (#${j.job_no}) at ${now} ${zone}`);
        } catch (e) {
          console.warn('[job] start/activate failed:', e?.message);
          return sendXml(res, `Sorry—couldn’t start that job. ${e?.message || ''}`.trim());
        }
      }
    }

    // 1) CREATE JOB <name>  (auto-activate)
    {
      const m = lc.match(/^create\s+job\s+(.+)$/i);
      if (m) {
        const name = m[1].trim();
        if (!name) return sendXml(res, 'Please provide a job name.');
        try {
          const j = await pg.activateJobByName(ownerId, name); // ensure + activate
          return sendXml(res, `✅ Job **${j.name}** (#${j.job_no}) created and set active.`);
        } catch (e) {
          console.warn('[job] create failed:', e?.message);
          return sendXml(res, `Couldn’t create job “${name}”.`);
        }
      }
    }

    // 2) SET ACTIVE JOB <#no|name>
    {
      const m = lc.match(/^(?:set\s+)?active\s+job\s+(.+)$/i);
      if (m) {
        const identRaw = m[1].trim();
        try {
          const ident = parseJobIdent(identRaw);
          let j;
          if (ident.jobNo) {
            j = await activateByJobNo(ownerId, ident.jobNo);
          } else {
            j = await pg.activateJobByName(ownerId, ident.name);
          }
          return sendXml(res, `Active job set to **${j.name}** (#${j.job_no}).`);
        } catch (e) {
          console.warn('[job] set-active failed:', e?.message);
          return sendXml(res, `Couldn’t set active job “${identRaw}”.`);
        }
      }
    }

    // 3) PAUSE / RESUME / FINISH JOB <#no|name>
    {
      // pause job X
      let m = lc.match(/^pause\s+job\s+(.+)$/i);
      if (m) {
        const ident = parseJobIdent(m[1].trim());
        try {
          const j = await pauseJob(ownerId, ident);
          return sendXml(res, `Paused job **${j?.name || m[1].trim()}**.`);
        } catch (e) {
          console.warn('[job] pause failed:', e?.message);
          return sendXml(res, `Couldn’t pause job “${m[1].trim()}”.`);
        }
      }

      // resume job X
      m = lc.match(/^resume\s+job\s+(.+)$/i);
      if (m) {
        const ident = parseJobIdent(m[1].trim());
        try {
          const j = await resumeJob(ownerId, ident);
          return sendXml(res, `Resumed job **${j.name}** (#${j.job_no}).`);
        } catch (e) {
          console.warn('[job] resume failed:', e?.message);
          return sendXml(res, `Couldn’t resume job “${m[1].trim()}”.`);
        }
      }

      // finish job X
      m = lc.match(/^finish\s+job\s+(.+)$/i);
      if (m) {
        const ident = parseJobIdent(m[1].trim());
        try {
          const j = await finishJob(ownerId, ident);
          return sendXml(res, `Finished job **${j?.name || m[1].trim()}**.`);
        } catch (e) {
          console.warn('[job] finish failed:', e?.message);
          return sendXml(res, `Couldn’t finish job “${m[1].trim()}”.`);
        }
      }
    }

    // 4) LIST JOBS
    if (/^list\s+jobs?$/i.test(lc)) {
      try {
        const jobs = await listRecentJobs(ownerId, 8);
        if (!jobs.length) return sendXml(res, 'No jobs yet.');
        const lines = jobs.map(j => `• **${j.name}** (#${j.job_no})${j.active ? ' (active)' : ''}`);
        return sendXml(res, `Jobs:\n${lines.join('\n')}`);
      } catch (e) {
        console.warn('[job] list failed:', e?.message);
        return sendXml(res, `Couldn’t list jobs.`);
      }
    }

    // 5) ACTIVE JOB?
    if (/^active\s+job\??$/i.test(lc)) {
      try {
        const j = await getActiveJobRow(ownerId);
        if (!j) return sendXml(res, 'No active job set.');
        return sendXml(res, `Active job: **${j.name}** (#${j.job_no}).`);
      } catch (e) {
        console.warn('[job] active? failed:', e?.message);
        return sendXml(res, `Couldn’t fetch active job.`);
      }
    }

    // 6) MOVE LAST LOG TO <job> [for <name>]
    {
      const mm = parseMoveLast(lc);
      if (mm && mm.jobName) {
        try {
          const employee = mm.forName || (userProfile?.name || from);
          const resMove = await moveLastEntryToJob(ownerId, employee, mm.jobName);
          if (!resMove.updated) throw new Error('no entry');
          return sendXml(res, `Last log for **${employee}** moved to **${resMove.job.name}** (#${resMove.job.job_no}).`);
        } catch (e) {
          console.warn('[job] move-last failed:', e?.message);
          return sendXml(res, `Couldn’t move last log to “${mm.jobName}”.`);
        }
      }
    }

    return false; // let other handlers try
  } catch (e) {
    console.error('[job] error:', e?.message);
    return sendXml(res, 'Job error. Try again.');
  } finally {
    // release per-request lock if present (serverless safety)
    try { res?.req?.releaseLock?.(); } catch {}
  }
}

module.exports = { handleJob };
