// api/webhook.js
const serverless = require('serverless-http');
const express = require('express');
const webhookRouter = require('../routes/webhook');

const app = express();

// Log every invocation
app.use((req, res, next) => {
  console.log('[SVLESS] hit', {
    url: req.originalUrl,
    method: req.method,
    ct: req.headers['content-type'] || null,
    cl: req.headers['content-length'] || null
  });
  next();
});

// HARD FAST-PATH for GET /  (Twilio sometimes does GET; reply TwiML immediately)
app.get('/', (_req, res) => {
  return res
    .status(200)
    .type('text/xml')
    .send('<Response><Message>OK</Message></Response>');
});

// 9s global watchdog (guarantee a reply for everything else)
app.use((req, res, next) => {
  if (!res.locals._svlessWatchdog) {
    res.locals._svlessWatchdog = setTimeout(() => {
      if (!res.headersSent) {
        console.warn('[SVLESS] 9s watchdog reply (fallback)');
        res
          .status(200)
          .type('text/xml')
          .send(
            '<Response><Message>Here’s what I can help with:\n\n' +
            '• Jobs — create job, list jobs, set active job &lt;name&gt;, active job?, close job &lt;name&gt;, move last log to &lt;name&gt;\n' +
            '• Tasks — task – buy nails, task Roof Repair – order shingles, task @Justin – pick up materials, tasks / my tasks, done #4, add due date Friday to task 3\n' +
            '• Timeclock — clock in/out, start/end break, start/end drive, timesheet week, clock in Justin @ Roof Repair 5pm' +
            '</Message></Response>'
          );
      }
    }, 9000);
    res.on('finish', () => clearTimeout(res.locals._svlessWatchdog));
    res.on('close',  () => clearTimeout(res.locals._svlessWatchdog));
  }
  next();
});

// Mount the actual webhook router for everything else
app.all('*', webhookRouter);

module.exports = serverless(app);
