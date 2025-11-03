// api/webhook_raw.js
module.exports = (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || '';
  const host  = req.headers['x-forwarded-host'] || req.headers.host || '';
  const ct    = req.headers['content-type'] || '';
  const cl    = req.headers['content-length'] || '';

  console.log('[WEBHOOK_RAW] hit', {
    method: req.method, url: req.url, proto, host, ct, cl, ts: Date.now()
  });

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/xml');
  if (req.method === 'POST') {
    res.end('<Response><Message>stub OK</Message></Response>');
  } else {
    res.end('<Response><Message>OK</Message></Response>');
  }
};
