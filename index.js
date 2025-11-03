// index.js
if (!process.env.VERCEL) { require('dotenv').config(); } // local only

const express = require('express');

const webhookRouter   = require('./routes/webhook');
const parseRouter     = require('./routes/parse');
const deepDiveRouter  = require('./routes/deepDive');
const dashboardRouter = require('./routes/dashboard');

const app = express();

// Hardening
app.disable('x-powered-by');

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store').send('Chief AI Webhook Server is running!');
});

// IMPORTANT: Mount webhook BEFORE any global parsers (we're not adding any global parsers here)
app.use('/api/webhook', webhookRouter);
app.use('/webhook', webhookRouter); // temporary alias

// Other routers can bring their own parsers if needed
app.use('/parse', parseRouter);
app.use('/deep-dive', deepDiveRouter);
app.use('/dashboard', dashboardRouter);

// Local dev server only; Vercel uses the exported handler
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
}

module.exports = app;
