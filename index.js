// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

console.log('[BOOT] Starting Chief AI...');

const app = express();
app.set('trust proxy', true);

// 📥 GLOBAL LOGGER: logs every incoming request
app.use((req, res, next) => {
  console.log(`[INCOMING] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(bodyParser.urlencoded({ extended: false, limit: '50mb' }));
app.use(bodyParser.json({ limit: '50mb' }));

// Health check (for uptime monitors)
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Mount routers
app.get('/', (_req, res) => {
  res.send('👋 Chief AI Webhook Server is up!');
});

app.use('/api/webhook', require('./routes/webhook'));
app.use('/parse', require('./routes/parse'));
app.use('/deep-dive', require('./routes/deepDive'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/exports', require('./routes/exports'));

// Catch-all 404 logger
app.use((req, res) => {
  console.warn(`[404] No route for ${req.method} ${req.originalUrl}`);
  res.status(404).send('Not Found');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
