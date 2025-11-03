// api/ping.js
module.exports = (req, res) => {
  // Minimal logging (should appear immediately on first hit)
  console.log('[PING] method:', req.method, 'ts:', Date.now());
  res.status(200).setHeader('Content-Type', 'text/plain');
  res.end('pong');
};
