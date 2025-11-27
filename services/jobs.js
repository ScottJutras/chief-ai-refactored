// services/jobs.js
const { getOne, insertOneReturning } = require('./db');
const { v4: uuidv4 } = require('uuid');

function looksLikeUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

/**
 * Resolve job_ref (id/name) to a job row.
 * If allowCreate is true and no job exists, create a draft Job.
 */
async function resolveJobRef(owner_id, job_ref, { allowCreate = false, defaultName } = {}) {
  if (!job_ref) {
    if (!allowCreate) return null;
    const name = defaultName || 'Untitled Job';
    return await createDraftJob(owner_id, name);
  }

  if (job_ref.id && looksLikeUuid(job_ref.id)) {
    const job = await getOne(
      'SELECT * FROM jobs WHERE owner_id = $1 AND id = $2',
      [owner_id, job_ref.id]
    );
    if (job) return job;
  }

  if (job_ref.name) {
    const job = await getOne(
      'SELECT * FROM jobs WHERE owner_id = $1 AND name ILIKE $2 ORDER BY created_at DESC LIMIT 1',
      [owner_id, `%${job_ref.name}%`]
    );
    if (job) return job;

    if (allowCreate) {
      return await createDraftJob(owner_id, job_ref.name);
    }
  }

  const err = new Error('Job not found');
  err.code = 'NOT_FOUND';
  throw err;
}

async function createDraftJob(owner_id, name) {
  return await insertOneReturning(
    `INSERT INTO jobs (id, owner_id, name, status)
     VALUES ($1, $2, $3, 'draft')
     RETURNING *`,
    [uuidv4(), owner_id, name]
  );
}

module.exports = { resolveJobRef, createDraftJob };
