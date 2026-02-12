// handlers/system/jobPickRouter.js
// Central router for job picker selections.
// This should be invoked BEFORE command parsing.
// It resolves job selection and resumes the pending flow safely.

function isJobPickToken(text) {
  return typeof text === 'string' && text.startsWith('jobpick::');
}

function parseJobPickToken(text) {
  const jobId = String(text || '').split('jobpick::')[1] || '';
  return jobId.trim();
}

/**
 * Resume the pending flow that requested a job pick.
 *
 * REQUIRED: You must already have a way to store "pending confirm flow":
 * - confirmFlowId
 * - context (expense_jobpick / revenue_jobpick / timeclock_jobpick / task_jobpick)
 * - draft payload (CIL draft or draft id)
 *
 * This function assumes you can call:
 *   pg.getPendingJobPick({ ownerId, pickUserId })
 *   pg.applyJobToPendingDraft({ ownerId, confirmFlowId, jobId })
 *   pg.clearPendingJobPick({ ownerId, confirmFlowId })
 *
 * If your exact function names differ, keep the pattern identical.
 */
async function handleJobPickSelection({ ctx, text, pg, twimlText, out }) {
  if (!isJobPickToken(text)) return { handled: false };

  const { ownerId, pickUserId } = ctx;
  const jobId = parseJobPickToken(text);

  if (!jobId) {
    return out(twimlText('That job selection looked invalid. Please try again.'), true);
  }

  // 1) Load pending picker state (must be owner-scoped + pickUserId-scoped)
  const pending = await pg.getPendingJobPick({ ownerId, pickUserId });

  if (!pending) {
    return out(
      twimlText(
        'That job selection has expired (or was already used). Please re-run the command that asked for a job.'
      ),
      true
    );
  }

  // 2) Apply job to the pending draft (CIL draft update, not direct mutation)
  // This MUST remain consistent with your CIL-only mutation rule.
  await pg.applyJobToPendingDraft({
    ownerId,
    confirmFlowId: pending.confirm_flow_id,
    jobId,
  });

  // 3) Clear pending state so it can’t loop/replay
  await pg.clearPendingJobPick({
    ownerId,
    confirmFlowId: pending.confirm_flow_id,
  });

  // 4) Resume the original flow
  // pending.next_intent could be: "expense_confirm", "revenue_confirm", etc.
  // Keep it deterministic: call the same function that would have continued after job resolution.
  await pending.resume_fn({ ctx, confirmFlowId: pending.confirm_flow_id });

  return { handled: true };
}

module.exports = {
  handleJobPickSelection,
  isJobPickToken,
  parseJobPickToken,
};
