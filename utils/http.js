// utils/http.js
function ack(res) {
  if (!res.headersSent) res.sendStatus(200);
}
module.exports = { ack };