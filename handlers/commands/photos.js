// handlers/commands/photos.js
// ─── Job photo WhatsApp commands ──────────────────────────────────────────────
//
// "Send me the job pictures for Job 257 Main St W, Exeter"
//   → Fetches photos for that job, sends MMS via Twilio
//
// "Send John Smith from Job 257 the job pictures"
//   → Looks up customer contact, generates gallery link, texts/emails them
//
// "Job photo" / "Photo" with an image attached → handled in media.js (not here)

const pg = require('../../services/postgres');

// ─── Intent detection ────────────────────────────────────────────────────────

const RETRIEVE_FOR_SELF_RE =
  /\b(?:send\s+me|get\s+me|show\s+me|what\s+are)\s+(?:the\s+)?(?:job\s+)?photos?\b.*(?:for\s+job\b|for\b)/i;

const RETRIEVE_FOR_CLIENT_RE =
  /\bsend\s+(.+?)\s+(?:from\s+job\b|\bthe\s+job\s+photos?\b|\bjob\s+photos?\b)/i;

const JOB_PHOTO_COMMAND_RE =
  /\b(?:job\s+photos?|site\s+photos?|project\s+photos?)\b/i;

function isPhotosCommand(text) {
  const t = String(text || '').trim();
  return RETRIEVE_FOR_SELF_RE.test(t) || RETRIEVE_FOR_CLIENT_RE.test(t) || JOB_PHOTO_COMMAND_RE.test(t);
}

// ─── Parse job name from message ─────────────────────────────────────────────

function parseJobRef(text) {
  // "for Job 257 Main St W", "from Job X", "Job: X"
  const m = text.match(/(?:for|from)\s+job[:\s]+(.+?)(?:\s*$|\.|,)/i)
    || text.match(/job[:\s]+(.+?)(?:\s*$|\.|,)/i);
  return m ? m[1].trim() : null;
}

function parseClientName(text) {
  const m = text.match(RETRIEVE_FOR_CLIENT_RE);
  return m ? m[1].trim() : null;
}

// ─── Job resolution ──────────────────────────────────────────────────────────

async function resolveJobByRef(ownerId, jobRef) {
  if (!jobRef) return null;
  try {
    const r = await pg.query(
      `SELECT id, job_no, job_name, name FROM public.jobs
       WHERE owner_id = $1
         AND deleted_at IS NULL
         AND (lower(job_name) ILIKE $2 OR lower(name) ILIKE $2)
       ORDER BY updated_at DESC LIMIT 1`,
      [ownerId, `%${jobRef.toLowerCase()}%`]
    );
    return r.rows[0] || null;
  } catch {
    return null;
  }
}

async function resolveTenantId(ownerId) {
  try {
    const r = await pg.query(
      `SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = $1 LIMIT 1`,
      [ownerId]
    );
    return r.rows[0]?.tenant_id || null;
  } catch {
    return null;
  }
}

// ─── Fetch photos for a job ───────────────────────────────────────────────────

async function fetchJobPhotos(jobId, tenantId, ownerId, limit = 10) {
  try {
    const r = await pg.query(
      `SELECT id, public_url, storage_path, storage_bucket, description, created_at
       FROM public.job_photos
       WHERE job_id   = $1
         AND tenant_id = $2
         AND owner_id  = $3
         AND public_url IS NOT NULL
       ORDER BY created_at DESC
       LIMIT $4`,
      [jobId, tenantId, ownerId, limit]
    );
    return r.rows;
  } catch {
    return [];
  }
}

// ─── Generate or reuse gallery share token ────────────────────────────────────

async function getOrCreateGalleryToken(jobId, tenantId, ownerId) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
    || process.env.APP_URL
    || process.env.VERCEL_URL
    || 'https://chiefos.app';

  try {
    // Reuse unexpired token if exists
    const existing = await pg.query(
      `SELECT token FROM public.job_photo_shares
       WHERE job_id   = $1
         AND tenant_id = $2
         AND owner_id  = $3
         AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [jobId, tenantId, ownerId]
    );

    if (existing.rows[0]?.token) {
      return `${appUrl}/gallery/${existing.rows[0].token}`;
    }

    // Create new share token
    const ins = await pg.query(
      `INSERT INTO public.job_photo_shares (tenant_id, job_id, owner_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '30 days')
       RETURNING token`,
      [tenantId, jobId, ownerId]
    );

    const token = ins.rows[0]?.token;
    return token ? `${appUrl}/gallery/${token}` : null;
  } catch (e) {
    console.error('[photos] getOrCreateGalleryToken failed:', e?.message);
    return null;
  }
}

// ─── Twilio MMS helpers ───────────────────────────────────────────────────────

function buildMmsReply(photos, jobLabel) {
  // Twilio WhatsApp supports up to 10 media attachments via REST API send
  // For TwiML, we can include MediaUrl for each image
  if (!photos.length) return null;

  const limit = photos.slice(0, 5); // limit to 5 for MMS
  const body = `📷 ${limit.length} photo${limit.length !== 1 ? 's' : ''} from ${jobLabel}:`;

  // Build multi-media TwiML
  const mediaXml = limit
    .map((p) => `<Media>${escapeXml(p.public_url)}</Media>`)
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(body)}${mediaXml}</Message></Response>`;
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function twiml(res, body) {
  res.status(200).type('application/xml; charset=utf-8')
    .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(body)}</Message></Response>`);
  return true;
}

// ─── Main handler ────────────────────────────────────────────────────────────

async function handlePhotos(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const raw = String(text || '').trim();
  if (!isPhotosCommand(raw)) return false;

  const tenantId = ownerProfile?.tenant_id || ownerProfile?.tenantId
    || await resolveTenantId(ownerId);

  if (!tenantId) {
    return twiml(res, '⚠️ Could not resolve your account.');
  }

  const jobRef = parseJobRef(raw);
  const job = await resolveJobByRef(ownerId, jobRef);

  if (!job) {
    return twiml(
      res,
      jobRef
        ? `Couldn't find a job matching "${jobRef}". Try: "Send me the job photos for 257 Main St"`
        : 'Which job? Try: "Send me the job photos for 257 Main St W"'
    );
  }

  const jobLabel = job.job_name || job.name || `Job #${job.job_no || job.id}`;
  const photos = await fetchJobPhotos(job.id, tenantId, ownerId);

  if (!photos.length) {
    return twiml(res, `No photos found for ${jobLabel}. Upload them in the portal or send photos via WhatsApp and tag this job.`);
  }

  // ── Send to client flow ───────────────────────────────────────────────────
  const clientName = parseClientName(raw);
  const isClientRequest = /\bsend\s+\w/.test(raw) && clientName && !raw.toLowerCase().includes('send me');

  if (isClientRequest) {
    const galleryUrl = await getOrCreateGalleryToken(job.id, tenantId, ownerId);
    if (!galleryUrl) {
      return twiml(res, `⚠️ Couldn't generate gallery link. Try again.`);
    }

    // Look up customer contact for this job
    let clientContact = null;
    try {
      const r = await pg.query(
        `SELECT c.name, c.phone, c.email
         FROM public.customers c
         JOIN public.job_documents jd ON jd.customer_id = c.id
         WHERE jd.job_id = $1 AND jd.tenant_id = $2
         LIMIT 1`,
        [job.id, tenantId]
      );
      clientContact = r.rows[0] || null;
    } catch {}

    const contactStr = clientContact?.email
      ? `Email it to ${clientContact.email}`
      : clientContact?.phone
      ? `Text it to ${clientContact.phone}`
      : 'Share this link with your client';

    return twiml(
      res,
      `Gallery link for ${jobLabel} (${photos.length} photo${photos.length !== 1 ? 's' : ''}):\n\n` +
      `${galleryUrl}\n\n` +
      `${contactStr}. Link expires in 30 days.`
    );
  }

  // ── Send to self (MMS) ────────────────────────────────────────────────────
  const mmsXml = buildMmsReply(photos, jobLabel);
  if (mmsXml) {
    res.status(200).type('application/xml; charset=utf-8').send(mmsXml);
    return true;
  }

  // Fallback: send gallery link to self
  const galleryUrl = await getOrCreateGalleryToken(job.id, tenantId, ownerId);
  return twiml(
    res,
    galleryUrl
      ? `View ${photos.length} photos for ${jobLabel}:\n${galleryUrl}`
      : `Found ${photos.length} photos for ${jobLabel} but couldn't send them. Check the portal.`
  );
}

module.exports = { handlePhotos, isPhotosCommand };
