const express = require('express');
const { handleInputWithAI, parseExpenseMessage, parseRevenueMessage, parseBillMessage, parseJobMessage, parseQuoteMessage } = require('../utils/aiErrorHandler');
const { tokenMiddleware } = require('../middleware/token');
const { userProfileMiddleware } = require('../middleware/userProfile');
const { errorMiddleware } = require('../middleware/error');

const router = express.Router();

router.post('/parse', userProfileMiddleware, tokenMiddleware, async (req, res, next) => {
  const { input, type = 'expense' } = req.body;
  const { userProfile, ownerId } = req;

  if (!input) {
    return res.status(400).json({ error: 'Missing input' });
  }

  if (!['expense', 'revenue', 'bill', 'job', 'quote'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type. Use: expense, revenue, bill, job, quote' });
  }

  const parseFn = {
    expense: parseExpenseMessage,
    revenue: parseRevenueMessage,
    bill: parseBillMessage,
    job: parseJobMessage,
    quote: parseQuoteMessage
  }[type];

  const defaultData = {
    expense: { date: new Date().toISOString().split('T')[0], item: 'Unknown', amount: '$0.00', store: 'Unknown Store' },
    revenue: { date: new Date().toISOString().split('T')[0], description: 'Payment', amount: '$0.00', source: 'Unknown Client' },
    bill: { date: new Date().toISOString().split('T')[0], billName: 'Unknown', amount: '$0.00', recurrence: 'one-time' },
    job: { jobName: 'Unknown Job' },
    quote: { jobName: 'Unknown Job', amount: 0, description: 'Unknown', client: 'Unknown Client' }
  }[type];

  try {
    const { data, reply, confirmed } = await handleInputWithAI(ownerId, input, type, parseFn, defaultData);
    console.log(`[DEBUG] POST /parse done processing for ${ownerId}: type=${type}, input="${input}"`);
    res.json({ data, reply, confirmed });
  } catch (error) {
    console.error(`[ERROR] in POST /parse for ${ownerId}:`, error.message);
    next(error); // Delegate to error middleware
  }
}, errorMiddleware);

module.exports = router;