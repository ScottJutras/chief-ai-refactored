// api/webhook.js
const serverless = require('serverless-http');
const express = require('express');
const webhookRouter = require('../routes/webhook');

const app = express();

// 0) Wrapper-level safety: if NOTHING sends a response in 9s, return a menu.
//    This protects you even if the router never fires for any reason.
app.use((req, res, next) => {
  if (!res.locals._wrapperSafety) {
    res.locals._wrapperSafety = setTimeout(() => {
      if (!res.headersSent) {
        console.warn('[SVLESS] 9s wrapper safety reply');
        res
          .status(200)
          .type('application/xml')
          .send(
            '<Response><Message>Here’s what I can help with:\n\n' +
              '• Jobs — create job, list jobs, set active job &lt;name&gt;, active job?, close job &lt;name&gt;, move last log to &lt;name&gt;\n' +
              '• Tasks — task – buy nails, task Roof Repair – order shingles, task @Justin – pick up materials, tasks / my tasks, done #4, add due date Friday to task 3\n' +
              '• Timeclock — clock in/out, start/end break, start/end drive, timesheet week, clock in Justin @ Roof Repair 5pm' +
            '</Message></Response>'
          );
      }
    }, 9000);
    const clear = () => clearTimeout(res.locals._wrapperSafety);
    res.on('finish', clear);
    res.on('close', clear);
  }
  next();
});

// 1) Very early logging so we can see verb and headers on every hit
app.use((req, _res, next) => {
  console.log('[SVLESS] hit', {
    url: req.originalUrl,
    method: req.method,
    ct: req.headers['content-type'] || null,
    cl: req.headers['content-length'] || null,
  });
  next();
});

// 2) Mount the webhook router (it has its own tolerant parser)
app.use('/', webhookRouter);

// 3) Health for GET /
app.get('/', (_req, res) => res.status(200).send('Webhook OK'));

// 4) Final safeguard: if absolutely nothing handled it, send OK TwiML.
//    (Normally unreachable, but guarantees a 200 to Twilio.)
app.use((req, res) => {
  if (!res.headersSent) {
    console.warn('[SVLESS] fell-through final safeguard');
    res.status(200).type('application/xml').send('<Response><Message>OK</Message></Response>');
  }
});

module.exports = serverless(app);
