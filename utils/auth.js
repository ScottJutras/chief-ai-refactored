const { google } = require('googleapis');

const credentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf8')
);

async function getAuthorizedClient() { // Changed from getAuth
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
  });
  return auth.getClient();
}

async function test() {
  try {
    const client = await getAuthorizedClient();
    console.log("[TEST] Authorized client:", client);
  } catch (e) {
    console.error("[TEST] Error:", e.message);
  }
}
test();

module.exports = {
  getAuthorizedClient, // Changed from getAuth
};