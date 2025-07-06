const express = require('express');
const bodyParser = require('body-parser');
const webhookRouter = require('./routes/webhook');
const parseRouter = require('./routes/parse');
const deepDiveRouter = require('./routes/deepDive');
const dashboardRouter = require('./routes/dashboard');

const app = express();

app.use(bodyParser.urlencoded({ extended: false, limit: '50mb' }));
app.use(bodyParser.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  console.log('[DEBUG] GET request received at root URL');
  res.send('Chief AI Webhook Server is running!');
});

app.use('/api/webhook', webhookRouter); // Reverted to match Twilio configuration
app.use('/parse', parseRouter);
app.use('/deep-dive', deepDiveRouter);
app.use('/dashboard', dashboardRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});