// utils/http.js
function ack(res) {
  if (!res.headersSent) res.sendStatus(200); // No TwiML, just acknowledge webhook
}
module.exports = { ack };