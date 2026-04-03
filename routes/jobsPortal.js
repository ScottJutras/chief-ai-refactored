const express = require("express");
const router = express.Router();

const pg = require("../services/postgres");
const { requirePortalUser } = require("../middleware/requirePortalUser");
const { getEffectivePlanKey } = require("../src/config/getEffectivePlanKey");

let supabaseAdmin = null;
try { supabaseAdmin = require("../services/supabaseAdmin"); } catch {}

function sanitizeJobName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

router.post("/api/jobs/create", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const tenantId = String(req.tenantId || "").trim();
    const ownerId = String(req.ownerId || "").trim();
    const portalRole = String(req.portalRole || "").trim().toLowerCase();
    const actorId = req.actorId ? String(req.actorId).trim() : null;

    if (!tenantId || !ownerId) {
      return res.status(403).json({
        ok: false,
        code: "TENANT_CONTEXT_REQUIRED",
        message: "Missing tenant context.",
      });
    }

    const allowed = new Set(["owner", "admin", "board", "board_member"]);
    if (portalRole && !allowed.has(portalRole)) {
      return res.status(403).json({
        ok: false,
        code: "PERMISSION_DENIED",
        message: "You do not have permission to create jobs.",
      });
    }

    const name = sanitizeJobName(req.body?.name);
    if (!name) {
      return res.status(400).json({
        ok: false,
        code: "BAD_REQUEST",
        message: "Job name is required.",
      });
    }

    if (typeof pg.createJobIdempotent !== "function") {
      return res.status(500).json({
        ok: false,
        code: "JOB_CREATE_UNAVAILABLE",
        message: "Job creation is not configured on the server.",
      });
    }

    let ownerProfile = null;
    try {
      const r = await pg.query(
        `
        select user_id, plan_key, sub_status, subscription_tier
        from public.users
        where user_id = $1
        limit 1
        `,
        [ownerId]
      );
      ownerProfile = r?.rows?.[0] || null;
    } catch (e) {
      console.warn("[JOBS_PORTAL] owner profile lookup failed:", e?.message);
      ownerProfile = null;
    }

    const plan = String(getEffectivePlanKey(ownerProfile) || "free").trim().toLowerCase();

    let maxJobs = null;
    try {
      const mod = require("../src/config/planCapabilities");
      const caps = mod?.plan_capabilities?.[plan] || mod?.plan_capabilities?.free || null;
      maxJobs = caps?.jobs?.max_jobs_total ?? null;

      if (typeof maxJobs === "string") {
        const s = maxJobs.trim().toLowerCase();
        if (s === "" || s === "null" || s === "undefined") maxJobs = null;
        else if (/^\d+(\.\d+)?$/.test(s)) maxJobs = Number(s);
      }
    } catch (e) {
      console.warn("[JOBS_PORTAL] plan capabilities load failed:", e?.message);
      maxJobs = null;
    }

    const hasJobLimit =
      maxJobs !== null &&
      maxJobs !== undefined &&
      Number.isFinite(Number(maxJobs)) &&
      Number(maxJobs) > 0;

    if (hasJobLimit) {
      try {
        const countRes = await pg.query(
          `
          select count(*)::int as c
          from public.jobs
          where owner_id = $1
          `,
          [ownerId]
        );

        const currentCount = Number(countRes?.rows?.[0]?.c || 0);
        if (currentCount >= Number(maxJobs)) {
          return res.status(200).json({
            ok: false,
            code: "PLAN_LIMIT_REACHED",
            message: `Job limit reached (${currentCount}/${maxJobs}). Upgrade your plan to create more jobs.`,
          });
        }
      } catch (e) {
        console.warn("[JOBS_PORTAL] job count gate failed (fail-open):", e?.message);
      }
    }

    const created = await pg.createJobIdempotent({
      ownerId,
      name,
      sourceMsgId: `portal_job_create:${tenantId}:${actorId || "portal"}:${name.toLowerCase()}`,
    });

    if (!created?.job) {
      return res.status(500).json({
        ok: false,
        code: "JOB_CREATE_FAILED",
        message: "Could not create the job.",
      });
    }

    const job = created.job;
    const jobName = sanitizeJobName(job.job_name || job.name || name);

    return res.status(200).json({
      ok: true,
      message: created.inserted
        ? `Created job: "${jobName}"${job.job_no != null ? ` (Job #${job.job_no})` : ""}.`
        : `That job already exists: "${jobName}"${job.job_no != null ? ` (Job #${job.job_no})` : ""}.`,
      job: {
        id: job.id ?? null,
        job_no: job.job_no ?? null,
        name: job.name ?? null,
        job_name: job.job_name ?? jobName,
      },
      inserted: !!created.inserted,
      reason: created.reason || null,
    });
  } catch (e) {
    console.error("[JOBS_PORTAL_CREATE] failed:", e?.message || e);
    return res.status(500).json({
      ok: false,
      code: "SERVER_ERROR",
      message: "Could not create the job.",
    });
  }
});

// ─── Shared auth + job resolution helper ──────────────────────────────────

function portalJobGuard(req, res) {
  const tenantId  = String(req.tenantId  || "").trim();
  const ownerId   = String(req.ownerId   || "").trim();
  const portalRole = String(req.portalRole || "").trim().toLowerCase();
  const jobId     = parseInt(req.params.jobId, 10);

  if (!tenantId || !ownerId) {
    res.status(403).json({ ok: false, code: "TENANT_CONTEXT_REQUIRED", message: "Missing tenant context." });
    return null;
  }
  if (!Number.isFinite(jobId)) {
    res.status(400).json({ ok: false, code: "BAD_REQUEST", message: "Invalid job ID." });
    return null;
  }

  const allowed = new Set(["owner", "admin", "board", "board_member"]);
  if (portalRole && !allowed.has(portalRole)) {
    res.status(403).json({ ok: false, code: "PERMISSION_DENIED", message: "You do not have permission to modify jobs." });
    return null;
  }

  return { tenantId, ownerId, jobId };
}

// ─── Archive job ───────────────────────────────────────────────────────────

router.post("/api/jobs/:jobId/archive", requirePortalUser(), async (req, res) => {
  try {
    const ctx = portalJobGuard(req, res);
    if (!ctx) return;
    const { ownerId, jobId } = ctx;

    const result = await pg.query(
      `UPDATE public.jobs
          SET status = 'archived', active = false, updated_at = now()
        WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING id, job_no, job_name, name, status`,
      [ownerId, jobId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "Job not found." });
    }
    return res.status(200).json({ ok: true, message: "Job archived.", job: result.rows[0] });
  } catch (e) {
    console.error("[JOBS_PORTAL_ARCHIVE] failed:", e?.message || e);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "Could not archive the job." });
  }
});

// ─── Unarchive job ─────────────────────────────────────────────────────────

router.post("/api/jobs/:jobId/unarchive", requirePortalUser(), async (req, res) => {
  try {
    const ctx = portalJobGuard(req, res);
    if (!ctx) return;
    const { ownerId, jobId } = ctx;

    const result = await pg.query(
      `UPDATE public.jobs
          SET status = 'active', active = true, updated_at = now()
        WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING id, job_no, job_name, name, status`,
      [ownerId, jobId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "Job not found." });
    }
    return res.status(200).json({ ok: true, message: "Job restored.", job: result.rows[0] });
  } catch (e) {
    console.error("[JOBS_PORTAL_UNARCHIVE] failed:", e?.message || e);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "Could not restore the job." });
  }
});

// ─── Delete job (soft delete) ──────────────────────────────────────────────

router.post("/api/jobs/:jobId/delete", requirePortalUser(), async (req, res) => {
  try {
    const ctx = portalJobGuard(req, res);
    if (!ctx) return;
    const { ownerId, jobId } = ctx;

    const result = await pg.query(
      `UPDATE public.jobs
          SET deleted_at = now(), active = false, updated_at = now()
        WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING id, job_no, job_name, name`,
      [ownerId, jobId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "Job not found or already deleted." });
    }
    return res.status(200).json({ ok: true, message: "Job deleted.", job: result.rows[0] });
  } catch (e) {
    console.error("[JOBS_PORTAL_DELETE] failed:", e?.message || e);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "Could not delete the job." });
  }
});

// ─── List phases for a job (with cost breakdown) ──────────────────────────────

router.get("/api/jobs/:jobId/phases", requirePortalUser(), async (req, res) => {
  try {
    const ctx = portalJobGuard(req, res);
    if (!ctx) return;
    const { tenantId, ownerId, jobId } = ctx;

    // Fetch phases for this job scoped to tenant
    const phasesRes = await pg.query(
      `SELECT
         jp.id,
         jp.phase_name,
         jp.started_at,
         jp.ended_at,
         jp.expires_at,
         COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END), 0)::bigint AS expense_cents,
         COALESCE(SUM(CASE WHEN t.kind = 'revenue' THEN t.amount_cents ELSE 0 END), 0)::bigint AS revenue_cents
       FROM public.job_phases jp
       LEFT JOIN public.transactions t
         ON  t.job_id    = jp.job_id
         AND t.tenant_id = jp.tenant_id
         AND t.transaction_date >= jp.started_at::date
         AND (jp.ended_at IS NULL OR t.transaction_date < jp.ended_at::date)
       WHERE jp.job_id    = $1
         AND jp.tenant_id = $2
         AND jp.owner_id  = $3
       GROUP BY jp.id
       ORDER BY jp.started_at ASC`,
      [jobId, tenantId, ownerId]
    );

    return res.status(200).json({ ok: true, phases: phasesRes.rows });
  } catch (e) {
    console.error("[JOBS_PORTAL_PHASES_LIST] failed:", e?.message || e);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "Could not load phases." });
  }
});

// ─── Remove a phase ────────────────────────────────────────────────────────────
// Deletes the phase row entirely. Entries that fell in this phase window
// become unphased (or fall into an adjacent phase) — no entries are modified.

router.delete("/api/jobs/:jobId/phases/:phaseId", requirePortalUser(), async (req, res) => {
  try {
    const ctx = portalJobGuard(req, res);
    if (!ctx) return;
    const { tenantId, ownerId, jobId } = ctx;
    const phaseId = String(req.params.phaseId || "").trim();

    if (!phaseId) {
      return res.status(400).json({ ok: false, code: "BAD_REQUEST", message: "Phase ID required." });
    }

    const result = await pg.query(
      `DELETE FROM public.job_phases
        WHERE id       = $1
          AND job_id   = $2
          AND tenant_id = $3
          AND owner_id  = $4
        RETURNING id, phase_name`,
      [phaseId, jobId, tenantId, ownerId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "Phase not found." });
    }

    return res.status(200).json({ ok: true, message: "Phase removed.", phase: result.rows[0] });
  } catch (e) {
    console.error("[JOBS_PORTAL_PHASES_DELETE] failed:", e?.message || e);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "Could not remove phase." });
  }
});

// ─── Job Photos — list ────────────────────────────────────────────────────────

router.get("/api/jobs/:jobId/photos", requirePortalUser(), async (req, res) => {
  try {
    const ctx = portalJobGuard(req, res);
    if (!ctx) return;
    const { tenantId, ownerId, jobId } = ctx;

    const result = await pg.query(
      `SELECT id, description, public_url, storage_path, storage_bucket, source, created_at
       FROM public.job_photos
       WHERE job_id   = $1
         AND tenant_id = $2
         AND owner_id  = $3
       ORDER BY created_at DESC`,
      [jobId, tenantId, ownerId]
    );

    return res.status(200).json({ ok: true, photos: result.rows });
  } catch (e) {
    console.error("[JOBS_PORTAL_PHOTOS_LIST]", e?.message);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "Could not load photos." });
  }
});

// ─── Job Photos — record portal upload ────────────────────────────────────────
// Frontend uploads directly to Supabase Storage, then POSTs the storage path here

router.post("/api/jobs/:jobId/photos", requirePortalUser(), express.json(), async (req, res) => {
  try {
    const ctx = portalJobGuard(req, res);
    if (!ctx) return;
    const { tenantId, ownerId, jobId } = ctx;

    const storagePath = String(req.body?.storagePath || "").trim();
    const publicUrl   = String(req.body?.publicUrl   || "").trim();
    const description = String(req.body?.description || "").trim() || null;

    if (!storagePath || !publicUrl) {
      return res.status(400).json({ ok: false, code: "BAD_REQUEST", message: "storagePath and publicUrl required." });
    }

    const result = await pg.query(
      `INSERT INTO public.job_photos
         (tenant_id, job_id, owner_id, storage_path, public_url, description, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'portal')
       RETURNING id, description, public_url, storage_path, created_at`,
      [tenantId, jobId, ownerId, storagePath, publicUrl, description]
    );

    return res.status(200).json({ ok: true, photo: result.rows[0] });
  } catch (e) {
    console.error("[JOBS_PORTAL_PHOTOS_INSERT]", e?.message);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "Could not save photo record." });
  }
});

// ─── Job Photos — delete ──────────────────────────────────────────────────────

router.delete("/api/jobs/:jobId/photos/:photoId", requirePortalUser(), async (req, res) => {
  try {
    const ctx = portalJobGuard(req, res);
    if (!ctx) return;
    const { tenantId, ownerId, jobId } = ctx;
    const photoId = String(req.params.photoId || "").trim();

    if (!photoId) {
      return res.status(400).json({ ok: false, code: "BAD_REQUEST", message: "Photo ID required." });
    }

    // Get storage path first so we can delete from storage
    const getRes = await pg.query(
      `SELECT storage_path, storage_bucket FROM public.job_photos
       WHERE id = $1 AND job_id = $2 AND tenant_id = $3 AND owner_id = $4`,
      [photoId, jobId, tenantId, ownerId]
    );

    if (!getRes.rows.length) {
      return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "Photo not found." });
    }

    const { storage_path, storage_bucket } = getRes.rows[0];

    // Delete from Supabase Storage (best-effort)
    if (supabaseAdmin && storage_path && storage_bucket) {
      try {
        const client = supabaseAdmin.getAdminClient();
        if (client) {
          await client.storage.from(storage_bucket).remove([storage_path]);
        }
      } catch (se) {
        console.warn("[JOBS_PORTAL_PHOTOS_DELETE] storage remove failed (ignored):", se?.message);
      }
    }

    await pg.query(
      `DELETE FROM public.job_photos WHERE id = $1 AND tenant_id = $2 AND owner_id = $3`,
      [photoId, tenantId, ownerId]
    );

    return res.status(200).json({ ok: true, message: "Photo deleted." });
  } catch (e) {
    console.error("[JOBS_PORTAL_PHOTOS_DELETE]", e?.message);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "Could not delete photo." });
  }
});

// ─── Job Photos — generate gallery share link ──────────────────────────────────

router.post("/api/jobs/:jobId/photos/share", requirePortalUser(), async (req, res) => {
  try {
    const ctx = portalJobGuard(req, res);
    if (!ctx) return;
    const { tenantId, ownerId, jobId } = ctx;

    const appUrl = process.env.NEXT_PUBLIC_APP_URL
      || process.env.APP_URL
      || process.env.VERCEL_URL
      || "https://chiefos.app";

    // Reuse unexpired token
    const existing = await pg.query(
      `SELECT token FROM public.job_photo_shares
       WHERE job_id   = $1 AND tenant_id = $2 AND owner_id = $3
         AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [jobId, tenantId, ownerId]
    );

    if (existing.rows[0]?.token) {
      return res.status(200).json({
        ok: true,
        url: `${appUrl}/gallery/${existing.rows[0].token}`,
        token: existing.rows[0].token,
        reused: true,
      });
    }

    const ins = await pg.query(
      `INSERT INTO public.job_photo_shares (tenant_id, job_id, owner_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '30 days')
       RETURNING token, expires_at`,
      [tenantId, jobId, ownerId]
    );

    const { token, expires_at } = ins.rows[0];
    return res.status(200).json({
      ok: true,
      url: `${appUrl}/gallery/${token}`,
      token,
      expiresAt: expires_at,
    });
  } catch (e) {
    console.error("[JOBS_PORTAL_PHOTOS_SHARE]", e?.message);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "Could not generate gallery link." });
  }
});

// ─── Gallery — public endpoint (no auth, uses token) ─────────────────────────

router.get("/api/gallery/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(400).json({ ok: false, message: "Token required." });

    const shareRes = await pg.query(
      `SELECT s.job_id, s.tenant_id, s.owner_id, s.expires_at,
              j.job_name, j.name
       FROM public.job_photo_shares s
       JOIN public.jobs j ON j.id = s.job_id
       WHERE s.token = $1`,
      [token]
    );

    if (!shareRes.rows.length) {
      return res.status(404).json({ ok: false, message: "Gallery not found or expired." });
    }

    const share = shareRes.rows[0];

    if (new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ ok: false, message: "Gallery link has expired." });
    }

    const photosRes = await pg.query(
      `SELECT id, description, public_url, created_at
       FROM public.job_photos
       WHERE job_id   = $1
         AND tenant_id = $2
         AND public_url IS NOT NULL
       ORDER BY created_at ASC`,
      [share.job_id, share.tenant_id]
    );

    return res.status(200).json({
      ok: true,
      job: { name: share.job_name || share.name },
      photos: photosRes.rows,
      expiresAt: share.expires_at,
    });
  } catch (e) {
    console.error("[GALLERY_PUBLIC]", e?.message);
    return res.status(500).json({ ok: false, message: "Could not load gallery." });
  }
});

module.exports = router;