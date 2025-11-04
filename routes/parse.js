// routes/parse.js
const express = require('express');
const {
  handleInputWithAI,
  parseExpenseMessage,
  parseRevenueMessage,
  parseBillMessage,
  parseJobMessage,
  parseQuoteMessage,
} = require('../utils/aiErrorHandler');
const { tokenMiddleware } = require('../middleware/token'); // ← only this
const { userProfileMiddleware } = require('../middleware/userProfile');
const { errorMiddleware } = require('../middleware/error');

const router = express.Router();

router.post(
  '/',
  userProfileMiddleware,
  tokenMiddleware,
  async (req, res, next) => {
    const { input, type = 'expense' } = req.body;
    const { ownerId } = req;

    if (!input) return res.status(400).json({ error: 'Missing input' });
    if (!['expense', 'revenue', 'bill', 'job', 'quote'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }

    const parseFn = {
      expense: parseExpenseMessage,
      revenue: parseRevenueMessage,
      bill: parseBillMessage,
      job: parseJobMessage,
      quote: parseQuoteMessage,
    }[type];

    const defaultData = {
      expense: { date: new Date().toISOString().split('T')[0], item: 'Unknown', amount: '$0.00', store: 'Unknown' },
      revenue: { date: new Date().toISOString().split('T')[0], description: 'Payment', amount: '$0.00', source: 'Unknown' },
      bill: { date: new Date().toISOString().split('T')[0], billName: 'Unknown', amount: '$0.00', recurrence: 'one-time' },
      job: { jobName: 'Unknown Job' },
      quote: { jobName: 'Unknown Job', amount: 0, description: 'Unknown', client: 'Unknown' },
    }[type];

    try {
      const { data, reply, confirmed } = await handleInputWithAI(ownerId, input, type, parseFn, defaultData);
      console.log('[parse] success', { ownerId, type, input: input.slice(0, 50) });
      res.json({ data, reply, confirmed });
    } catch (error) {
      // This will now be caught by errorMiddleware
      next(error);
    }
  }
);

// ← errorMiddleware must be LAST and have 4 args
router.use(errorMiddleware);

module.exports = router;