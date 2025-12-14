const path = require('path');
const fs = require('fs');
const express = require('express');
const OpenAI = require('openai');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

console.log('__dirname:', __dirname);
try {
  console.log('resolve:', require.resolve('./services/firebase'));
} catch (e) {
  console.error('resolve failed:', e.message);
}

const { admin, db } = require('./services/firebase');
const webhookRouter = require('./routes/webhook');

// Google Vision and OpenAI setup
console.log("[DEBUG] Checking environment variables...");
console.log("[DEBUG] GOOGLE_CREDENTIALS_BASE64:", process.env.GOOGLE_CREDENTIALS_BASE64 ? "Loaded" : "Missing");
console.log("[DEBUG] FIREBASE_CREDENTIALS_BASE64:", process.env.FIREBASE_CREDENTIALS_BASE64 ? "Loaded" : "Missing");
console.log("[DEBUG] OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "Loaded" : "Missing");

console.log("[DEBUG] TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID ? "Loaded" : "MISSING");
console.log("[DEBUG] TWILIO_AUTH_TOKEN:", process.env.TWILIO_AUTH_TOKEN ? "Loaded" : "MISSING");
console.log("[DEBUG] TWILIO_WHATSAPP_NUMBER:", process.env.TWILIO_WHATSAPP_NUMBER ? "Loaded" : "MISSING");
console.log("[DEBUG] TWILIO_MESSAGING_SERVICE_SID:", process.env.TWILIO_MESSAGING_SERVICE_SID ? "Loaded" : "MISSING");

const googleCredentials = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
console.log('[DEBUG] Service account email from GOOGLE_CREDENTIALS_BASE64:', googleCredentials.client_email);

const googleVisionBase64 = process.env.GOOGLE_VISION_CREDENTIALS_BASE64 || process.env.GOOGLE_CREDENTIALS_BASE64;
if (!googleVisionBase64) {
  throw new Error("[ERROR] Missing Google Vision API credentials. Ensure GOOGLE_CREDENTIALS_BASE64 is set.");
}
const visionCredentialsPath = '/tmp/google-vision-key.json';
fs.writeFileSync(visionCredentialsPath, Buffer.from(googleVisionBase64, 'base64'));
process.env.GOOGLE_APPLICATION_CREDENTIALS = visionCredentialsPath;
console.log("[DEBUG] Google Vision Application Credentials set successfully.");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const environment = process.env.NODE_ENV || 'development';
console.log(`[DEBUG] Environment: ${environment}`);

// Express setup
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Mount webhook router
app.use('/api/webhook', webhookRouter);

// Root route for verification
app.get('/', (req, res) => {
  console.log('[DEBUG] GET request received at root URL');
  res.send('Hello, Chief AI!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});