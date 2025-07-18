const express = require('express');
const bodyParser = require('body-parser');
const favicon = require('serve-favicon');
const path = require('path');
const webhookRouter = require('./routes/webhook');
const dashboardRouter = require('./routes/dashboard');
const deepDiveRouter = require('./handlers/deepDive');
const { errorMiddleware } = require('./middleware/error');

const app = express();

// Serve favicon
app.use(favicon(path.join(__dirname, 'public', 'favicon.png')));

// Global logger
app.use((req, res, next) => {
  console.log(`[INCOMING] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

app.get('/', (req, res) => {
  console.log('[DEBUG] GET /');
  res.send('👋 Chief AI Webhook Server is up!');
});

// Check router objects to prevent "got Object" error
function assertRouter(r, name) {
  if (typeof r !== 'function' && typeof r !== 'object') {
    throw new Error(`[BOOT] ${name} is not a valid router!`);
  }
  // If it's an object, try to detect a named export problem
  if (typeof r === 'object' && typeof r.handle !== 'function') {
    throw new Error(`[BOOT] ${name} looks like an object, not an Express router. Check your export!`);
  }
}
assertRouter(webhookRouter, 'webhookRouter');
assertRouter(dashboardRouter, 'dashboardRouter');
assertRouter(deepDiveRouter, 'deepDiveRouter');

app.use('/api/webhook', webhookRouter);
app.use('/dashboard', dashboardRouter);
app.use('/deep-dive', deepDiveRouter);

app.use((req, res) => {
  console.warn(`[404] No route for ${req.method} ${req.originalUrl}`);
  res.status(404).send('Not Found');
});

app.use(errorMiddleware);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[BOOT] Chief AI server running on port ${PORT}`);
});

module.exports = app;