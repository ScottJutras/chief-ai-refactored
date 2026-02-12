// services/whatsapp/inboundInteractive.js
// Canonical inbound text resolver for Twilio WhatsApp (interactive-aware).
//
// NON-NEGOTIABLE: If Twilio gives a list selection ID (e.g. jp:... or job_3_xxx),
// we must preserve that stable token and NEVER rewrite it into something else
// that changes semantics and can cause loops.
//
// This file is the ONE canonical place that decides "what text did the user send?"

function safeStr(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function extractStampedJobNo(title = '') {
  const s = String(title || '').trim();
  if (!s) return null;
  const m = s.match(/\bJ(\d{1,10})\b/i);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extracts a job picker *index* from either:
 * - Content-template token: "job_5_44fc8181" => 5
 * - Title prefix: "#5 Happy Road" => 5
 * Returns number or null.
 *
 * NOTE: This is only for older templates that used job_<index> tokens.
 * Newer stable ids are "jp:<...>" and should pass through untouched.
 */
function extractJobPickerIndexFromToken(s) {
  const str = String(s || '').trim();
  if (!str) return null;

  // job_<index>_<nonce>
  let m = str.match(/^job_(\d+)_/i);
  if (m?.[1]) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  // "#<index> <title>"
  m = str.match(/^#\s*(\d+)\b/);
  if (m?.[1]) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

/**
 * Canonical inbound resolver:
 * - Buttons: payload/text (lowercased)
 * - InteractiveResponseJson: prefer list_reply.id (row id)
 * - Twilio list fields: prefer RowId/ListId over Body over Title
 * - Preserve stable IDs (jp:...) exactly as-is
 * - Back-compat: if token looks like "job_<ix>_<nonce>" normalize to "jobix_<ix>"
 */
function resolveInboundTextFromTwilio(body = {}) {
  const b = body || {};
  const rawBody = safeStr(b.Body).trim();

  // 1) Buttons / quick replies
  const payload = safeStr(b.ButtonPayload || b.buttonPayload).trim();
  if (payload) return payload.toLowerCase();

  const btnText = safeStr(b.ButtonText || b.buttonText).trim();
  if (btnText && btnText.length <= 40) return btnText.toLowerCase();

  // 2) InteractiveResponseJson (best signal)
  const irj = b.InteractiveResponseJson || b.interactiveResponseJson || null;
  if (irj) {
    try {
      const json = typeof irj === 'string' ? JSON.parse(irj) : irj;

      const id =
        json?.list_reply?.id ||
        json?.listReply?.id ||
        json?.interactive?.list_reply?.id ||
        json?.interactive?.listReply?.id ||
        '';

      const title =
        json?.list_reply?.title ||
        json?.listReply?.title ||
        json?.interactive?.list_reply?.title ||
        json?.interactive?.listReply?.title ||
        '';

      const pickedId = safeStr(id).trim();
      const pickedTitle = safeStr(title).trim();

      // If title contains stamped job number like "J8", allow jobno recovery
      const stamped = extractStampedJobNo(pickedTitle);
      if (stamped) return `jobno_${stamped}`;

      // ✅ Preserve stable IDs (jp:...) exactly
      if (pickedId && pickedId.startsWith('jp:')) return pickedId;

      // Back-compat: normalize old content-template ids like job_5_xxx -> jobix_5
      const jobIx = extractJobPickerIndexFromToken(pickedId || pickedTitle);
      if (jobIx != null) return `jobix_${jobIx}`;

      if (pickedId) return pickedId;
      if (pickedTitle) return pickedTitle;
    } catch {}
  }

  // 3) Twilio list picker fields (RowId/Id preferred)
  const listRowId = safeStr(b.ListRowId || b.ListRowID || b.listRowId || b.listRowID).trim();
  const listRowTitle = safeStr(b.ListRowTitle || b.listRowTitle).trim();

  const listId = safeStr(
    b.ListId ||
      b.listId ||
      b.ListItemId ||
      b.listItemId ||
      b.ListReplyId ||
      b.listReplyId
  ).trim();

  const listTitle = safeStr(
    b.ListTitle ||
      b.listTitle ||
      b.ListItemTitle ||
      b.listItemTitle ||
      b.ListReplyTitle ||
      b.listReplyTitle
  ).trim();

  const candidateTitle = listRowTitle || listTitle;

  // stamped job number in title (J8)
  const stamped = extractStampedJobNo(candidateTitle);
  if (stamped) return `jobno_${stamped}`;

  // ✅ Preserve stable IDs (jp:...) exactly
  const idCandidate = listRowId || listId;
  if (idCandidate && idCandidate.startsWith('jp:')) return idCandidate;

  // Back-compat: normalize old ids like job_5_xxx -> jobix_5
  const ixFromId = extractJobPickerIndexFromToken(idCandidate);
  if (ixFromId != null) return `jobix_${ixFromId}`;

  const ixFromTitle = extractJobPickerIndexFromToken(candidateTitle);
  if (ixFromTitle != null) return `jobix_${ixFromTitle}`;

  // Prefer ID fields if present (stable)
  if (listRowId) return listRowId;
  if (listId) return listId;

  // Body fallback (but still normalize old job_<ix> tokens)
  if (rawBody) {
    if (rawBody.startsWith('jp:')) return rawBody;
    const ixFromBody = extractJobPickerIndexFromToken(rawBody);
    if (ixFromBody != null) return `jobix_${ixFromBody}`;
    return rawBody;
  }

  if (candidateTitle) return candidateTitle;

  return '';
}

module.exports = {
  resolveInboundTextFromTwilio,
};
