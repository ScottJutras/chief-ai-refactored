const { db } = require('../services/firebase');

/**
 * Error-handling middleware for Express routes.
 * Handles errors from webhook, parse, and deep-dive routes, formatting responses
 * appropriately (WhatsApp TwiML or JSON) and releasing locks for WhatsApp requests.
 * @param {Error} err - The error object.
 * @param {Object} req - The Express request object.
 * @param {Object} res - The Express response object.
 * @param {Function} next - The next middleware function.
 */
async function errorMiddleware(err, req, res, next) {
  console.error(`[ERROR] ${req.method} ${req.path} failed:`, err.message, err.stack);

  // Determine if this is a WhatsApp webhook request
  const isWebhook = req.path === '/webhook' && req.body.From;
  const from = req.body.From ? req.body.From.replace(/\D/g, "") : 'unknown';
  const lockKey = `lock:${from}`;

  // Handle specific error cases
  let message = 'An error occurred. Please try again later.';
  let status = 500;

  if (err.message.includes('Trial limit reached')) {
    message = '⚠️ Trial limit reached! Reply "Upgrade" to continue.';
    status = 403;
  } else if (err.message.includes('Invalid userId or tier')) {
    message = '⚠️ Invalid request. Please check your input.';
    status = 400;
  } else if (err.message.includes('No financial data provided')) {
    message = '⚠️ No financial data provided for processing.';
    status = 400;
  } else if (err.message.includes('Parsing failed')) {
    message = '⚠️ Failed to parse input. Please try again.';
    status = 400;
  } else if (err.message.includes('Spreadsheet creation failed')) {
    message = '⚠️ Failed to create spreadsheet. Please try again.';
    status = 500;
  } else if (err.message.includes('Receipt processing failed')) {
    message = '⚠️ Failed to process receipt image. Please try again.';
    status = 500;
  } else if (err.message.includes('Invalid expense format')) {
    message = '⚠️ Invalid expense format. Try: "expense $100 tools from Home Depot"';
    status = 400;
  } else if (err.message.includes('Invalid revenue format')) {
    message = '⚠️ Invalid revenue format. Try: "received $100 from John"';
    status = 400;
  } else if (err.message.includes('Invalid bill format')) {
    message = '⚠️ Invalid bill format. Try: "bill Truck Payment $760 monthly"';
    status = 400;
  } else if (err.message.includes('Invalid job name')) {
    message = '⚠️ Please provide a valid job name. Try: "start job Roof Repair"';
    status = 400;
  } else if (err.message.includes('No active job')) {
    message = '⚠️ No active job found. Start a job first.';
    status = 400;
  } else if (err.message.includes('Invalid quote format')) {
    message = '⚠️ Invalid quote format. Try: "quote $500 for Roof Repair to John"';
    status = 400;
  } else if (err.message.includes('Unsupported media type')) {
    message = '⚠️ Unsupported media type. Please send a JPEG/PNG image or MP3/WAV/OGG audio.';
    status = 400;
  } else if (err.message.includes('No media detected')) {
    message = '⚠️ No valid data extracted from media. Please try again with a clear image or audio.';
    status = 400;
  } else if (err.message.includes('Only the owner can')) {
    message = err.message; // e.g., "Only the owner can start jobs"
    status = 403;
  } else if (err.message.includes('Invalid delete request')) {
    message = '⚠️ Invalid delete request. Try: "delete expense $100 tools from Home Depot"';
    status = 400;
  } else if (err.message.includes('Failed to fetch metrics')) {
    message = '⚠️ Failed to fetch financial metrics. Please try again.';
    status = 500;
  }

  // Release lock for WhatsApp requests
  if (isWebhook) {
    try {
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (error)`);
    } catch (lockError) {
      console.error(`[ERROR] Failed to release lock for ${from}:`, lockError.message);
    }
  }

  // Format response based on route
  if (isWebhook) {
    res.send(`<Response><Message>${message}</Message></Response>`);
  } else {
    res.status(status).json({ error: message });
  }
}

module.exports = { errorMiddleware };