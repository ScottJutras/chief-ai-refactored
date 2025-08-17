const express = require('express');
const bodyParser = require('body-parser');

console.log('[BOOT] Starting Chief AI...');

const app = express();

// GLOBAL LOGGER: logs every incoming request
app.use((req, res, next) => {
  console.log(`[INCOMING] ${req.method} ${req.originalUrl}`);
  console.log('  headers:', JSON.stringify(req.headers));
  // Twilio sends urlencoded bodies
  // so we need bodyParser first
  next();
});

app.use(bodyParser.urlencoded({ extended: false, limit: '50mb' }));
app.use(bodyParser.json({ limit: '50mb' }));

// mount routers
app.get('/', (req, res) => {
  console.log('[DEBUG] GET /');
  res.send('👋 Chief AI Webhook Server is up!');
});

app.use('/api/webhook', require('./routes/webhook'));
app.use('/parse', require('./routes/parse'));
app.use('/dashboard', require('./routes/dashboard'));

// catch-all 404 logger
app.use((req, res) => {
  console.warn(`[404] No route for ${req.method} ${req.originalUrl}`);
  res.status(404).send('Not Found');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});