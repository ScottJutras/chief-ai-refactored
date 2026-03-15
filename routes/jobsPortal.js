const express = require("express");
const router = express.Router();

const pg = require("../services/postgres");
const { requirePortalUser } = require("../middleware/requirePortalUser");
const { getEffectivePlanKey } = require("../src/config/getEffectivePlanKey");

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

module.exports = router;