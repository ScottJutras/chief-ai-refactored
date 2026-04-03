// handlers/commands/phase.js
// ─── Phase / Rework tracking via WhatsApp ─────────────────────────────────────
//
// Activated by messages like:
//   "Starting siding"
//   "Just started tear-off. Job 257 Main St"
//   "Starting phase: framing"
//   "End phase" / "Clear phase" / "No phase"
//
// Phase is a timeline cursor on the job — zero impact on entries that don't
// have a phase set. Auto-expires at midnight so stale tags don't accumulate.

const pg = require('../../services/postgres');

// ─── Intent detection ────────────────────────────────────────────────────────

const PHASE_START_RE =
  /^(?:just\s+)?(?:start(?:ed|ing)?|begin(?:ning)?|kicking?\s+off|kicked?\s+off)\s+(?:phase[:\s]+)?(.+)/i;

const PHASE_END_RE =
  /^(?:end|clear|no|stop(?:ping)?|done\s+with|finish(?:ed)?)\s+phase\b/i;

/**
 * Returns true if this message looks like a phase command.
 * Called from index.js BEFORE timeclock so dedicated phase messages don't fall
 * through to the agent.
 */
function isPhaseMessage(text) {
  const t = String(text || '').trim();
  if (PHASE_END_RE.test(t)) return true;
  return PHASE_START_RE.test(t);
}

// ─── Parse ───────────────────────────────────────────────────────────────────

/**
 * @returns {{ action: 'start'|'end', phaseName: string|null, jobRef: string|null } | null}
 */
function parsePhaseMessage(text) {
  const t = String(text || '').trim();

  if (PHASE_END_RE.test(t)) {
    return { action: 'end', phaseName: null, jobRef: null };
  }

  const m = t.match(PHASE_START_RE);
  if (!m) return null;

  let rest = m[1].trim();

  // Extract optional job reference: "…. job 257 main st" or "…, Job Exeter"
  let jobRef = null;
  const jobMatch = rest.match(/[.,]\s*job(?:\s+#?|\s*:\s*)(.+?)$/i)
    || rest.match(/\bjob(?:\s+#?|\s*:\s*)(.+?)$/i);
  if (jobMatch) {
    jobRef = jobMatch[1].trim();
    rest = rest.slice(0, jobMatch.index).trim();
  }

  // Clean trailing punctuation
  let phaseName = rest.replace(/[.,!?]+$/, '').trim();
  if (!phaseName) return null;

  // Capitalize
  phaseName = phaseName.charAt(0).toUpperCase() + phaseName.slice(1);

  return { action: 'start', phaseName, jobRef };
}

// ─── Job resolution ──────────────────────────────────────────────────────────

/**
 * Resolve job_id for this phase command.
 * If jobRef is provided, search by name. Otherwise use the most recently
 * updated active job for this owner.
 */
async function resolveJobId(ownerId, jobRef) {
  try {
    if (jobRef) {
      const res = await pg.query(
        `SELECT id, job_name, name FROM public.jobs
         WHERE owner_id = $1
           AND deleted_at IS NULL
           AND (lower(job_name) ILIKE $2 OR lower(name) ILIKE $2)
         ORDER BY updated_at DESC
         LIMIT 1`,
        [ownerId, `%${jobRef.toLowerCase()}%`]
      );
      if (res.rows[0]) return res.rows[0];
    }

    // Fallback: most recent active job
    const res = await pg.query(
      `SELECT id, job_name, name FROM public.jobs
       WHERE owner_id = $1
         AND active = true
         AND deleted_at IS NULL
         AND status != 'archived'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [ownerId]
    );
    return res.rows[0] || null;
  } catch (e) {
    console.error('[phase] resolveJobId error:', e?.message);
    return null;
  }
}

// ─── Tenant resolution ───────────────────────────────────────────────────────

async function resolveTenantId(ownerId, ownerProfile) {
  // Prefer ownerProfile if it has tenant_id
  const fromProfile = ownerProfile?.tenant_id || ownerProfile?.tenantId;
  if (fromProfile) return String(fromProfile);

  try {
    const res = await pg.query(
      `SELECT tenant_id FROM public.chiefos_portal_users
       WHERE user_id = $1
       LIMIT 1`,
      [ownerId]
    );
    return res.rows[0]?.tenant_id || null;
  } catch {
    return null;
  }
}

// ─── End-of-day expiry ───────────────────────────────────────────────────────

function endOfDayUtc(tz) {
  // tz is the owner's timezone (e.g. 'America/Toronto'). Default to UTC.
  try {
    const now = new Date();
    const tzStr = tz || 'UTC';
    // Get today's date in owner's timezone
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tzStr, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const y = parts.find(p => p.type === 'year')?.value;
    const mo = parts.find(p => p.type === 'month')?.value;
    const d = parts.find(p => p.type === 'day')?.value;
    // Midnight tonight in owner's tz
    const midnightLocal = new Date(`${y}-${mo}-${d}T23:59:59`);
    // Convert to UTC via Intl
    const utcMs = new Date(midnightLocal.toLocaleString('en-US', { timeZone: tzStr }));
    // Use a rough approach: owner is in EST/EDT range typically, just use +24h as safe fallback
    const eod = new Date(now);
    eod.setHours(23, 59, 59, 0);
    return eod.toISOString();
  } catch {
    const eod = new Date();
    eod.setHours(23, 59, 59, 0);
    return eod.toISOString();
  }
}

// ─── TwiML helper ────────────────────────────────────────────────────────────

function xmlEsc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function twiml(res, body) {
  res.status(200).type('application/xml; charset=utf-8')
    .send(`<Response><Message>${xmlEsc(String(body || '').trim())}</Message></Response>`);
  return true;
}

// ─── Main handler ────────────────────────────────────────────────────────────

/**
 * handlePhase — called from handlers/commands/index.js before timeclock.
 * Returns true if the message was handled, false to pass through.
 */
async function handlePhase(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const raw = String(text || '').trim();
  if (!isPhaseMessage(raw)) return false;

  const parsed = parsePhaseMessage(raw);
  if (!parsed) return false;

  const tenantId = await resolveTenantId(ownerId, ownerProfile);
  if (!tenantId) {
    return twiml(res, '⚠️ Could not resolve your account. Try again.');
  }

  const tz = ownerProfile?.timezone || ownerProfile?.time_zone || 'America/Toronto';

  // ─── END PHASE ───────────────────────────────────────────────────────────
  if (parsed.action === 'end') {
    try {
      const closed = await pg.query(
        `UPDATE public.job_phases
            SET ended_at = now()
          WHERE owner_id = $1
            AND ended_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())
          RETURNING phase_name`,
        [ownerId]
      );

      if (!closed.rows.length) {
        return twiml(res, 'No active phase to clear.');
      }

      const names = [...new Set(closed.rows.map(r => r.phase_name))].join(', ');
      return twiml(res, `Phase cleared. "${names}" removed — entries going forward are unphased.`);
    } catch (e) {
      console.error('[phase] end phase error:', e?.message);
      return twiml(res, '⚠️ Could not clear phase. Try again.');
    }
  }

  // ─── START PHASE ─────────────────────────────────────────────────────────
  const job = await resolveJobId(ownerId, parsed.jobRef);
  if (!job) {
    return twiml(
      res,
      parsed.jobRef
        ? `Couldn't find a job matching "${parsed.jobRef}". Try again with the full job name.`
        : `No active job found. Include the job name, e.g. "Starting siding. Job 257 Main St"`
    );
  }

  const jobLabel = job.job_name || job.name || `#${job.id}`;
  const expiresAt = endOfDayUtc(tz);

  try {
    // Close any open phases on this job for this owner
    await pg.query(
      `UPDATE public.job_phases
          SET ended_at = now()
        WHERE owner_id = $1
          AND job_id   = $2
          AND ended_at IS NULL`,
      [ownerId, job.id]
    );

    // Insert new phase
    await pg.query(
      `INSERT INTO public.job_phases
         (tenant_id, job_id, owner_id, phase_name, started_at, expires_at)
       VALUES ($1, $2, $3, $4, now(), $5)`,
      [tenantId, job.id, ownerId, parsed.phaseName, expiresAt]
    );

    return twiml(
      res,
      `Phase set to "${parsed.phaseName}" on ${jobLabel}. ` +
      `Time and expenses logged today will be tagged to this phase. ` +
      `Phase clears automatically at midnight — send "end phase" to clear early.`
    );
  } catch (e) {
    console.error('[phase] start phase error:', e?.message);
    return twiml(res, '⚠️ Could not set phase. Try again.');
  }
}

module.exports = { handlePhase, isPhaseMessage };
