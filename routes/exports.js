// routes/exports.js
// GET /exports/:id  → returns stored xlsx/pdf file
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pg = require('../services/postgres');

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[a-f0-9]{16,64}$/i.test(id)) return res.status(400).send('Bad export id');

    const { rows } = await pg.query(
      `SELECT filename, content_type, bytes FROM file_exports WHERE id=$1 LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).send('Not found');

    const { filename, content_type, bytes } = rows[0];
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

    res.set('Content-Type', content_type || 'application/octet-stream');
    const disp = req.query.download ? 'attachment' : 'inline';
    res.set('Content-Disposition', `${disp}; filename="${filename || 'export'}"`);
    res.set('Cache-Control', 'public, max-age=3600, immutable');

    const etag = crypto.createHash('sha1').update(buf).digest('hex');
    res.set('ETag', `"${etag}"`);
    if (req.headers['if-none-match'] === `"${etag}"`) return res.status(304).end();

    res.set('Content-Length', String(buf.length));
    return res.status(200).send(buf);
  } catch (e) {
    console.error('[exports] error:', e?.message);
    return res.status(500).send('Server error');
  }
});

module.exports = router;