// routes/parse.js
//
// POST /parse
// Body: { input: string, type: 'expense'|'revenue'|'bill'|'job'|'quote' }
//
// Alignments:
// - Handles handleInputWithAI signature drift (some builds expect fromPhone; others expect ownerId)
// - Uses req.ownerId when available; otherwise falls back safely
// - Keeps errorMiddleware last

const express = require('express');

const ai = require('../utils/aiErrorHandler');
const {
  handleInputWithAI,
  parseExpenseMessage,
  parseRevenueMessage,
  parseBillMessage,
  parseJobMessage,
  parseQuoteMessage,
} = ai;

const { tokenMiddleware } = require('../middleware/token');
const { userProfileMiddleware } = require('../middleware/userProfile');
const { errorMiddleware } = require('../middleware/error');

const router = express.Router();

function isoToday() {
  return new Date().toISOString().split('T')[0];
}

function pickParseFn(type) {
  return {
    expense: parseExpenseMessage,
    revenue: parseRevenueMessage,
    bill: parseBillMessage,
    job: parseJobMessage,
    quote: parseQuoteMessage,
  }[type];
}

function pickDefaultData(type) {
  const today = isoToday();
  return {
    expense: { date: today, item: 'Unknown', amount: '$0.00', store: 'Unknown' },
    revenue: { date: today, description: 'Payment', amount: '$0.00', source: 'Unknown' },
    bill: { date: today, billName: 'Unknown', amount: '$0.00', recurrence: 'one-time' },
    job: { jobName: 'Unknown Job' },
    quote: { jobName: 'Unknown Job', amount: 0, description: 'Unknown', client: 'Unknown' },
  }[type];
}

/**
 * handleInputWithAI signature differs across builds:
 * - Some: handleInputWithAI(fromPhone, input, type, parseFn, defaultData, ...)
 * - Others: handleInputWithAI(ownerId, input, type, parseFn, defaultData, ...)
 *
 * We try both in a safe order.
 */
async function handleInputWithAICompat({ ownerId, from, input, type, parseFn, defaultData }) {
  // Try "from" first (matches your command handlers)
  try {
    const r = await handleInputWithAI(from || ownerId, input, type, parseFn, defaultData);
    return r;
  } catch (e1) {
    // Try "ownerId" explicitly
    try {
      const r = await handleInputWithAI(ownerId, input, type, parseFn, defaultData);
      return r;
    } catch (e2) {
      // throw the more informative error if possible
      throw e2?.message ? e2 : e1;
    }
  }
}

router.post(
  '/',
  userProfileMiddleware,
  tokenMiddleware,
  async (req, res, next) => {
    try {
      const { input, type = 'expense' } = req.body || {};
      const ownerId = String(req.ownerId || req.owner_id || '').trim();
      const from = String(req.from || req.userProfile?.user_id || ownerId || '').trim();

      if (!input || !String(input).trim()) return res.status(400).json({ error: 'Missing input' });

      const t = String(type || '').toLowerCase();
      if (!['expense', 'revenue', 'bill', 'job', 'quote'].includes(t)) {
        return res.status(400).json({ error: 'Invalid type' });
      }

      const parseFn = pickParseFn(t);
      const defaultData = pickDefaultData(t);

      if (typeof handleInputWithAI !== 'function' || typeof parseFn !== 'function') {
        return res.status(500).json({ error: 'Parser not configured' });
      }

      const trimmed = String(input).trim().slice(0, 12000);

      const { data, reply, confirmed } = await handleInputWithAICompat({
        ownerId: ownerId || from,
        from,
        input: trimmed,
        type: t,
        parseFn,
        defaultData
      });

      console.log('[parse] success', { ownerId: ownerId || null, type: t, input: trimmed.slice(0, 80) });

      res.json({ data, reply, confirmed });
    } catch (err) {
      next(err);
    }
  }
);

// errorMiddleware must be LAST and have 4 args
router.use(errorMiddleware);

module.exports = router;
