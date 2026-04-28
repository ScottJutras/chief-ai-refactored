// src/cil/signatureNameMatch.js — §11a name-match implementation.
//
// Deliberate design choices (per §11a's "no smart handling" posture):
//
// 1. Unicode pass-through. Diacritics are preserved during normalization.
//    "García" and "Garcia" produce different last-tokens and therefore
//    mismatch. This is intentional — §11a rejects active diacritic folding
//    because it's a smart-handling choice with localization risk (is "ñ"
//    the same as "n"? depends on culture). The mismatch produces a
//    forensic event; contractor reviews manually if legitimate.
//
// 2. No suffix stripping. "MacDonald Jr." and "MacDonald" produce
//    different last-tokens ("jr" vs "macdonald") and therefore mismatch.
//    §11a doesn't maintain a suffix table. Same forensic-event posture.
//
// 3. Last-token compare (not full-name compare). Spouse signatures work:
//    "Robert MacDonald" typed against "Darlene MacDonald" recipient both
//    have last-token "macdonald" → match. This is deliberate per §11a
//    because family members often sign for each other in contractor
//    contexts, and the signature binds the household to the contract.
//
// Rule versioning: NAME_MATCH_RULE_ID is pinned per algorithm version.
// Changes to normalization or comparison logic require a new rule ID.
// The ID is stored in integrity.name_mismatch_signed event payloads so
// audit queries can distinguish events across rule versions.
//
// Doctype-agnostic: this module composes into SignQuote today; future
// invoice / change-order / contract signature handlers import it
// directly. The §11a canonical template applies to all doc-type
// signature tables.

/**
 * Rule version identifier — pinned per algorithm version. Changes to
 * normalizeForNameMatch or the comparison logic require a new rule ID.
 * Stored in integrity.name_mismatch_signed event payloads; future
 * algorithm versions can coexist historically without audit drift.
 */
const NAME_MATCH_RULE_ID = 'last_token_normalize_v1';

/**
 * normalizeForNameMatch — §11a normalization pipeline.
 *
 * Pipeline:
 *   lowercase → strip non-letter/non-number (preserve whitespace)
 *   → collapse spaces → trim → split on whitespace → take last token
 *
 * Returns { normalized, lastToken }. lastToken is null for empty /
 * whitespace-only / non-string input. normalized is '' for non-string.
 *
 * Unicode posture: uses \p{L}\p{N} (Unicode letter/number) via /u flag.
 * "García" normalizes to "garcía" (diacritic preserved). §11a explicitly
 * says "no diacritic handling" — interpreted as "no active normalization
 * of diacritics"; they pass through and mismatch accordingly when one
 * side has them and the other doesn't.
 *
 * @param {unknown} raw
 * @returns {{ normalized: string, lastToken: string | null }}
 */
function normalizeForNameMatch(raw) {
  if (typeof raw !== 'string') return { normalized: '', lastToken: null };
  const normalized = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')   // strip non-letter/non-number (preserve whitespace)
    .replace(/\s+/g, ' ')               // collapse runs of whitespace
    .trim();
  if (normalized.length === 0) return { normalized: '', lastToken: null };
  const tokens = normalized.split(' ');
  return { normalized, lastToken: tokens[tokens.length - 1] };
}

/**
 * computeNameMatch — applies the §11a name-match rule.
 *
 * @param {unknown} recipientName — name from share_token.recipient_name
 * @param {unknown} typedName     — name typed by customer at signing time
 * @returns {{
 *   matches: boolean,
 *   ruleId: string,
 *   recipientLastToken: string | null,
 *   typedLastToken: string | null,
 *   recipientNormalized: string,
 *   typedNormalized: string
 * }}
 *
 * matches: true iff both inputs produced non-null last-tokens AND the
 * tokens are byte-equal after normalization.
 *
 * Consumers:
 *   - SignQuote handler: stores `matches` in
 *     chiefos_quote_signatures.name_match_at_sign column.
 *   - SignQuote handler (mismatch branch): embeds ruleId + both tokens +
 *     both normalized forms in the integrity.name_mismatch_signed event
 *     payload for forensic replay.
 */
function computeNameMatch(recipientName, typedName) {
  const recipient = normalizeForNameMatch(recipientName);
  const typed = normalizeForNameMatch(typedName);
  const matches = !!(
    recipient.lastToken &&
    typed.lastToken &&
    recipient.lastToken === typed.lastToken
  );
  return {
    matches,
    ruleId: NAME_MATCH_RULE_ID,
    recipientLastToken: recipient.lastToken,
    typedLastToken: typed.lastToken,
    recipientNormalized: recipient.normalized,
    typedNormalized: typed.normalized,
  };
}

module.exports = {
  computeNameMatch,
  NAME_MATCH_RULE_ID,
  _internals: {
    normalizeForNameMatch,
  },
};
