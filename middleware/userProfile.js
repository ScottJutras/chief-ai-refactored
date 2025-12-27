// middleware/userProfile.js
const pg = require('../services/postgres');
const { getUserProfile, createUserProfile, getOwnerProfile } = pg;

/**
 * Normalizes inbound "From" / owner identifiers to the ID shape your DB expects.
 * Your current system uses digits-only identity (no whatsapp:, no +).
 */
function normalizeId(raw) {
  return String(raw || '')
    .replace(/^whatsapp:/i, '')
    .replace(/\D/g, '')
    .trim() || null;
}

function shapeProfile(p, from) {
  const user_id = p?.user_id || p?.id || from;
  const owner_id = p?.owner_id || p?.ownerId || user_id;
  const plan = (p?.plan || p?.subscription_tier || 'free').toLowerCase();

  return {
    user_id,
    owner_id,
    ownerId: owner_id,
    phone: p?.phone || user_id,
    name: p?.name || p?.display_name || null,
    subscription_tier: plan,
    plan,
    onboarding_in_progress: Boolean(p?.onboarding_in_progress || p?.onboardingPending || false),

    // active job (will be hydrated best-effort below)
    active_job_id: p?.active_job_id ?? p?.activeJobId ?? null,
    active_job_name: p?.active_job_name ?? p?.activeJobName ?? null,

    ...p
  };
}

function looksLikeUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str || ''));
}

/**
 * Best-effort: get active job fields for this identity.
 * Prefers pg.getActiveJobForIdentity if you implement it later.
 * Otherwise tries memberships/users/user_profiles.
 *
 * Returns: { active_job_id, active_job_name } | null
 */
async function fetchActiveJobForIdentity({ ownerId, from, userProfile }) {
  const ownerParam = String(ownerId || '').trim();
  const userId = String(userProfile?.user_id || userProfile?.id || from || '').trim();

  if (!ownerParam || !userId) return null;

  // Preferred: a real helper (clean canonical source)
  if (typeof pg.getActiveJobForIdentity === 'function') {
    try {
      const out = await pg.getActiveJobForIdentity(ownerParam, String(from));
      if (out && (out.active_job_id != null || out.active_job_name != null || out.activeJobId != null || out.activeJobName != null)) {
        return {
          active_job_id: out.active_job_id ?? out.activeJobId ?? null,
          active_job_name: out.active_job_name ?? out.activeJobName ?? null
        };
      }
    } catch (e) {
      console.warn('[userProfile] pg.getActiveJobForIdentity failed (ignored):', e?.message);
    }
  }

  // Best-effort SQL attempts (fail-open on missing tables/columns)
  const attempts = [
    {
      label: 'memberships (owner_id + user_id)',
      sql: `SELECT active_job_id, active_job_name
              FROM public.memberships
             WHERE owner_id = $1 AND user_id = $2
             LIMIT 1`,
      params: [ownerParam, userId]
    },
    {
      label: 'users (owner_id + id)',
      sql: `SELECT active_job_id, active_job_name
              FROM public.users
             WHERE owner_id = $1 AND id = $2
             LIMIT 1`,
      params: [ownerParam, userId]
    },
    {
      label: 'user_profiles (owner_id + user_id)',
      sql: `SELECT active_job_id, active_job_name
              FROM public.user_profiles
             WHERE owner_id = $1 AND user_id = $2
             LIMIT 1`,
      params: [ownerParam, userId]
    }
  ];

  for (const a of attempts) {
    try {
      const r = await pg.query(a.sql, a.params);
      const row = r?.rows?.[0];
      if (!row) continue;

      const active_job_id = row.active_job_id ?? null;
      const active_job_name = row.active_job_name != null ? String(row.active_job_name).trim() : null;

      if (active_job_id != null || (active_job_name && active_job_name.length > 0)) {
        console.info('[userProfile] active job fetched', {
          where: a.label,
          hasId: active_job_id != null,
          hasName: !!active_job_name
        });
        return { active_job_id, active_job_name };
      }
    } catch {
      // ignore schema mismatch
    }
  }

  return null;
}

/**
 * If we have an id but no name, resolve name from jobs.
 * Supports UUID id or numeric job_no.
 */
async function resolveJobNameFromJobsTable({ ownerId, active_job_id }) {
  if (active_job_id == null) return null;
  const ownerParam = String(ownerId || '').trim();
  const s = String(active_job_id).trim();
  if (!ownerParam || !s) return null;

  // UUID job id
  if (looksLikeUuid(s)) {
    try {
      const r = await pg.query(
        `SELECT COALESCE(name, job_name) AS job_name
           FROM public.jobs
          WHERE owner_id = $1 AND id = $2::uuid
          LIMIT 1`,
        [ownerParam, s]
      );
      const name = r?.rows?.[0]?.job_name;
      return name ? String(name).trim() : null;
    } catch {
      // ignore
    }
  }

  // numeric job_no
  if (/^\d+$/.test(s)) {
    try {
      const r = await pg.query(
        `SELECT COALESCE(name, job_name) AS job_name
           FROM public.jobs
          WHERE owner_id = $1 AND job_no = $2::int
          LIMIT 1`,
        [ownerParam, Number(s)]
      );
      const name = r?.rows?.[0]?.job_name;
      return name ? String(name).trim() : null;
    } catch {
      // ignore
    }
  }

  return null;
}

async function userProfileMiddleware(req, _res, next) {
  try {
    const from = normalizeId(req.body?.From || req.from);
    req.from = from;

    // Normalize ownerId too (if upstream sets it from phone / whatsapp:)
    const ownerFromReq = normalizeId(req.ownerId);
    req.ownerId = ownerFromReq || from || 'GLOBAL';

    if (!from) {
      req.userProfile = null;
      req.ownerProfile = null;
      req.isOwner = false;
      return next();
    }

    // Load or create the user
    let profile = await getUserProfile(from);
    if (!profile) {
      profile = await createUserProfile({ user_id: from, ownerId: from, onboarding_in_progress: true });
      console.log('[userProfile] created new user', from);
    }
    profile = shapeProfile(profile, from); // ensure consistent shape

    // Also fetch the owner profile (your handlers receive this)
    let ownerProfile = null;
    try {
      ownerProfile = await getOwnerProfile(req.ownerId);
    } catch (e) {
      console.warn('[userProfile] getOwnerProfile failed:', e?.message);
    }
    if (ownerProfile) ownerProfile = shapeProfile(ownerProfile, req.ownerId);

    // ✅ Hydrate active job into userProfile (canonical for downstream handlers)
    try {
      const hasActiveAlready =
        (profile.active_job_name && String(profile.active_job_name).trim()) || profile.active_job_id != null;

      if (!hasActiveAlready) {
        const fetched = await fetchActiveJobForIdentity({ ownerId: req.ownerId, from, userProfile: profile });
        if (fetched) {
          profile.active_job_id = fetched.active_job_id ?? null;
          profile.active_job_name = fetched.active_job_name ?? null;
        }
      }

      // If we got an id but no name, resolve name from jobs table
      if ((!profile.active_job_name || !String(profile.active_job_name).trim()) && profile.active_job_id != null) {
        const resolvedName = await resolveJobNameFromJobsTable({
          ownerId: req.ownerId,
          active_job_id: profile.active_job_id
        });
        if (resolvedName) profile.active_job_name = resolvedName;
      }
    } catch (e) {
      console.warn('[userProfile] active job hydrate failed (ignored):', e?.message);
    }

    req.userProfile = profile;
    req.ownerProfile = ownerProfile;

    // You currently treat owner as: user_id === ownerId
    req.isOwner = String(profile.user_id) === String(req.ownerId);

    if (profile.onboarding_in_progress) {
      console.log('[userProfile] onboarding pending for', from);
      // (Optional) short-circuit to onboarding flow here
    }

    return next();
  } catch (e) {
    console.warn('[userProfile] failed:', e?.message);
    return next();
  }
}

module.exports = { userProfileMiddleware };
