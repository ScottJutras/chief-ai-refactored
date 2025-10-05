// routes/exports.js
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pg = require('../services/postgres');

// GET /exports/:id  → returns the stored file (xlsx/pdf)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // basic sanity check: our IDs are hex from crypto.randomBytes(12/16)
    if (!/^[a-f0-9]{16,64}$/i.test(id)) {
      return res.status(400).send('Bad export id');
    }

    const { rows } = await pg.query(
      `SELECT filename, content_type, bytes FROM file_exports WHERE id=$1 LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).send('Not found');

    const { filename, content_type, bytes } = rows[0];
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

    // headers
    res.set('Content-Type', content_type || 'application/octet-stream');
    // support preview by default; allow forcing download via ?download=1
    const disp = req.query.download ? 'attachment' : 'inline';
    res.set('Content-Disposition', `${disp}; filename="${filename || 'export'}"`);

    // caching: immutable by id – safe to cache a while
    res.set('Cache-Control', 'public, max-age=3600, immutable');

    // ETag for revalidation
    const etag = crypto.createHash('sha1').update(buf).digest('hex');
    res.set('ETag', `"${etag}"`);
    if (req.headers['if-none-match'] === `"${etag}"`) {
      return res.status(304).end();
    }

    // content length helps some clients
    res.set('Content-Length', String(buf.length));

    return res.status(200).send(buf);
  } catch (e) {
    console.error('[ERROR] /exports/:id', e);
    return res.status(500).send('Server error');
  }
});

module.exports = router;
