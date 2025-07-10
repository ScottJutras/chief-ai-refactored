const express = require('express');
const webhookRouter = require('./routes/webhook');
const deepDiveRouter = require('./routes/deepDive');
const dashboardRouter = require('./routes/dashboard');

const app = express();

app.use((req, res, next) => {
  console.log(`[INCOMING] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/', (req, res) => {
  console.log('[DEBUG] GET /');
  res.send('👋 Chief AI Webhook Server is up!');
});

app.use('/api/webhook', webhookRouter);
app.use('/deep-dive', deepDiveRouter);
app.use('/dashboard', dashboardRouter);

app.use((req, res) => {
  console.warn(`[404] No route for ${req.method} ${req.originalUrl}`);
  res.status(404).send('Not Found');
});

app.use(require('./middleware/error').errorMiddleware);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[BOOT] Chief AI server running on port ${port}`);
});

module.exports = app;