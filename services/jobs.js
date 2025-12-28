// services/jobs.js
// ------------------------------------------------------------
// Legacy compatibility wrapper.
// Canonical job logic lives in services/postgres.js.
// This file exists so older callers don't break.
// ------------------------------------------------------------
const pg = require('./postgres');

function looksLikeInt(x) {
  return /^\d+$/.test(String(x || '').trim());
}

function OWNER(x) {
  const s = String(x ?? '').trim();
  return s || null;
}

/**
 * Resolve job_ref (id/name) to a job row.
 *
 * Supported job_ref shapes:
 *  - { id: 123 }            -> resolves by integer jobs.id (NOT uuid)
 *  - { job_no: 7 }          -> resolves by (owner_id, job_no)
 *  - { name: 'Oak Street' } -> resolves by job_name/name (fuzzy-ish)
 *
 * If allowCreate is true and no job exists, creates one (draft/open).
 */
async function resolveJobRef(
  owner_id,
  job_ref,
  { allowCreate = false, defaultName, sourceMsgId = null } = {}
) {
  const owner = OWNER(owner_id);
  if (!owner) throw new Error('Missing owner_id');

  // If nothing provided, optionally create
  if (!job_ref) {
    if (!allowCreate) return null;
    const name = String(defaultName || 'Untitled Job').trim() || 'Untitled Job';
    const created = await pg.createJobIdempotent({
      ownerId: owner,
      jobName: name,
      sourceMsgId,
      status: 'draft',
      active: true,
    });
    return created?.job || null;
  }

  // 1) Resolve by integer jobs.id
  if (job_ref.id && looksLikeInt(job_ref.id)) {
    const { rows } = await pg.query(
      `SELECT id, owner_id, job_no,
              COALESCE(job_name, name) AS job_name,
              name, status, active, created_at, updated_at, source_msg_id
         FROM public.jobs
        WHERE owner_id = $1 AND id = $2
        LIMIT 1`,
      [owner, Number(job_ref.id)]
    );
    if (rows?.[0]) return rows[0];
  }

  // 2) Resolve by job_no
  if (job_ref.job_no && looksLikeInt(job_ref.job_no)) {
    const { rows } = await pg.query(
      `SELECT id, owner_id, job_no,
              COALESCE(job_name, name) AS job_name,
              name, status, active, created_at, updated_at, source_msg_id
         FROM public.jobs
        WHERE owner_id = $1 AND job_no = $2
        LIMIT 1`,
      [owner, Number(job_ref.job_no)]
    );
    if (rows?.[0]) return rows[0];
  }

  // 3) Resolve by name (prefer exact-ish, otherwise ILIKE)
  if (job_ref.name) {
    const needle = String(job_ref.name).trim();
    if (needle) {
      const exact = await pg.query(
        `SELECT id, owner_id, job_no,
                COALESCE(job_name, name) AS job_name,
                name, status, active, created_at, updated_at, source_msg_id
           FROM public.jobs
          WHERE owner_id = $1
            AND (lower(job_name) = lower($2) OR lower(name) = lower($2))
          ORDER BY updated_at DESC NULLS LAST, created_at DESC
          LIMIT 1`,
        [owner, needle]
      );
      if (exact?.rowCount) return exact.rows[0];

      const like = await pg.query(
        `SELECT id, owner_id, job_no,
                COALESCE(job_name, name) AS job_name,
                name, status, active, created_at, updated_at, source_msg_id
           FROM public.jobs
          WHERE owner_id = $1
            AND (job_name ILIKE $2 OR name ILIKE $2)
          ORDER BY updated_at DESC NULLS LAST, created_at DESC
          LIMIT 1`,
        [owner, `%${needle}%`]
      );
      if (like?.rowCount) return like.rows[0];

      if (allowCreate) {
        const created = await pg.createJobIdempotent({
          ownerId: owner,
          jobName: needle,
          sourceMsgId,
          status: 'draft',
          active: true,
        });
        return created?.job || null;
      }
    }
  }

  const err = new Error('Job not found');
  err.code = 'NOT_FOUND';
  throw err;
}

async function createDraftJob(owner_id, name, { sourceMsgId = null } = {}) {
  const owner = OWNER(owner_id);
  if (!owner) throw new Error('Missing owner_id');

  const jobName = String(name || '').trim() || 'Untitled Job';
  const created = await pg.createJobIdempotent({
    ownerId: owner,
    jobName,
    sourceMsgId,
    status: 'draft',
    active: true,
  });

  return created?.job || null;
}

module.exports = { resolveJobRef, createDraftJob };
