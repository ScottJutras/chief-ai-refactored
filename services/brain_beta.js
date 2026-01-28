const brainV0 = require('./brain_v0');

// Optional: inject your existing agent service (OpenAI wrapper) here.
// This MUST NOT calculate totals; it only rewrites provided facts.
async function narrateWithLLM({ prompt, agent }) {
  if (!agent) return null;
  try {
    const r = await agent.generateText({ prompt, maxTokens: 250 }); // adapt to your wrapper
    return String(r?.text || '').trim() || null;
  } catch {
    return null;
  }
}

async function answerBeta({ ownerId, actorKey, text, tz = 'America/Toronto', agent = null }) {
  // Step 1: attempt Brain v0
  const v0 = await brainV0.answer({ ownerId, actorKey, text, tz });
  if (!v0?.ok) return v0; // unsupported_intent bubbles to fallback

  // Step 2: if no agent, return deterministic answer
  if (!agent) return v0;

  // Step 3: narrate (no new facts)
  const truthBundle = {
    answer: v0.answer,
    evidence: v0.evidence,
    rules: [
      'Do not add any new numbers.',
      'Do not infer missing totals.',
      'If something is missing, say it is missing.',
      'Keep it concise.'
    ]
  };

  const prompt =
`You are ChiefOS. Rewrite the following answer to be clearer and more conversational.
You MUST NOT introduce any facts or numbers not already present.

TRUTH_BUNDLE:
${JSON.stringify(truthBundle, null, 2)}

Return only the rewritten answer text.`;

  const rewritten = await narrateWithLLM({ prompt, agent });
  if (!rewritten) return v0;

  return { ...v0, answer: rewritten };
}

module.exports = { answerBeta };
