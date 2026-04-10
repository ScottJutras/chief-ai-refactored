'use strict';

/**
 * Agent Tool: get_job_photos
 * Returns photos for a job with URLs and a shareable gallery link.
 * Used when owner asks "show me photos from Job 47" or "send me site pictures".
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const PORTAL_BASE = () =>
  String(process.env.PORTAL_BASE_URL || process.env.APP_BASE_URL || 'https://app.usechiefos.com').replace(/\/$/, '');

async function getJobPhotos({ ownerId, jobId, jobNo, jobName, phase }) {
  if (!ownerId) return { error: 'owner_id is required' };

  // Resolve job
  let resolvedJobId = jobId || null;
  let resolvedJobName = jobName || null;
  let resolvedJobNo = jobNo || null;

  if (!resolvedJobId) {
    let q, params;
    if (jobNo) {
      q = `SELECT id, name, job_no FROM public.jobs WHERE owner_id::text = $1 AND job_no = $2 LIMIT 1`;
      params = [String(ownerId), Number(jobNo)];
    } else if (jobName) {
      q = `SELECT id, name, job_no FROM public.jobs WHERE owner_id::text = $1 AND LOWER(name) LIKE LOWER($2)
           AND status NOT IN ('archived','cancelled') ORDER BY created_at DESC LIMIT 1`;
      params = [String(ownerId), `%${jobName}%`];
    } else {
      // Most recent active job
      q = `SELECT id, name, job_no FROM public.jobs WHERE owner_id::text = $1
           AND status NOT IN ('archived','cancelled') ORDER BY updated_at DESC LIMIT 1`;
      params = [String(ownerId)];
    }
    const r = await pool.query(q, params).catch(() => null);
    if (r?.rows?.[0]) {
      resolvedJobId = String(r.rows[0].id);
      resolvedJobName = r.rows[0].name;
      resolvedJobNo = r.rows[0].job_no;
    }
  } else {
    const r = await pool.query(
      `SELECT name, job_no FROM public.jobs WHERE owner_id::text = $1 AND id = $2 LIMIT 1`,
      [String(ownerId), resolvedJobId]
    ).catch(() => null);
    if (r?.rows?.[0]) {
      resolvedJobName = r.rows[0].name;
      resolvedJobNo = r.rows[0].job_no;
    }
  }

  if (!resolvedJobId) return { error: 'Job not found', found: false };

  // Fetch photos
  const phaseFilter = phase ? `AND photo_phase = $3` : '';
  const params = phase
    ? [String(ownerId), resolvedJobId, phase]
    : [String(ownerId), resolvedJobId];

  const photosResult = await pool.query(
    `SELECT id, public_url, description, photo_phase, source, created_at
     FROM public.job_photos
     WHERE owner_id = $1 AND job_id = $2 ${phaseFilter}
     ORDER BY created_at DESC
     LIMIT 50`,
    params
  ).catch(() => null);

  const photos = (photosResult?.rows || []).map(p => ({
    id: p.id,
    url: p.public_url,
    caption: p.description || null,
    phase: p.photo_phase || null,
    source: p.source,
    taken_at: p.created_at,
  }));

  // Get or create a share token
  let galleryUrl = null;
  try {
    const tenantRow = await pool.query(
      `SELECT id FROM public.chiefos_tenants
       WHERE regexp_replace(coalesce(owner_id,''), '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g')
       LIMIT 1`,
      [String(ownerId)]
    );
    const tenantId = tenantRow?.rows?.[0]?.id;
    if (tenantId) {
      const existingShare = await pool.query(
        `SELECT token FROM public.job_photo_shares
         WHERE owner_id = $1 AND job_id = $2 AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [String(ownerId), resolvedJobId]
      );
      if (existingShare?.rows?.[0]?.token) {
        galleryUrl = `${PORTAL_BASE()}/photos/${existingShare.rows[0].token}`;
      } else {
        const newShare = await pool.query(
          `INSERT INTO public.job_photo_shares (tenant_id, job_id, owner_id, label)
           VALUES ($1, $2, $3, $4) RETURNING token`,
          [tenantId, resolvedJobId, String(ownerId), resolvedJobName || 'Job photos']
        );
        if (newShare?.rows?.[0]?.token) {
          galleryUrl = `${PORTAL_BASE()}/photos/${newShare.rows[0].token}`;
        }
      }
    }
  } catch {}

  const byPhase = { before: 0, during: 0, after: 0, untagged: 0 };
  for (const p of photos) {
    if (p.phase === 'before') byPhase.before++;
    else if (p.phase === 'during') byPhase.during++;
    else if (p.phase === 'after') byPhase.after++;
    else byPhase.untagged++;
  }

  return {
    found: true,
    job_id: resolvedJobId,
    job_no: resolvedJobNo,
    job_name: resolvedJobName,
    photo_count: photos.length,
    phase_filter: phase || null,
    by_phase: byPhase,
    gallery_url: galleryUrl,
    photos: photos.slice(0, 10), // return first 10 for agent context
    has_more: photos.length > 10,
  };
}

const photoQueryTool = {
  type: 'function',
  function: {
    name: 'get_job_photos',
    description: [
      'Get photos for a job. Returns photo list, phase counts (before/during/after), and a shareable gallery link.',
      'Use when the user asks "show me photos from Job 47", "send me site pictures", "do we have before photos for this job?".',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id'],
      properties: {
        owner_id:  { type: 'string' },
        job_id:    { type: 'string', description: 'Job UUID' },
        job_no:    { type: 'integer', description: 'Job number' },
        job_name:  { type: 'string', description: 'Job name (partial match)' },
        phase:     { type: 'string', enum: ['before','during','after'], description: 'Filter by photo phase (optional)' },
      },
    },
  },
  __handler: async (args) => {
    try {
      return await getJobPhotos({
        ownerId:  String(args.owner_id || '').trim(),
        jobId:    args.job_id   ? String(args.job_id).trim()  : null,
        jobNo:    args.job_no   ? Number(args.job_no)          : null,
        jobName:  args.job_name ? String(args.job_name).trim() : null,
        phase:    args.phase    ? String(args.phase).trim()    : null,
      });
    } catch (err) {
      return { error: `get_job_photos failed: ${err?.message}` };
    }
  },
};

module.exports = { photoQueryTool, getJobPhotos };
