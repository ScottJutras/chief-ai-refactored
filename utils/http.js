// utils/http.js
function ack(res) {
  if (!res.headersSent) {
    // Return 200 with NO BODY (or an empty TwiML body).
    // Either of these is fine; pick one and keep it consistent.

    // Option 1: empty body
    // res.status(200).end();

    // Option 2: empty TwiML (recommended with Twilio)
    res.status(200).type('text/xml').send('<Response/>');
  }
}
module.exports = { ack };
