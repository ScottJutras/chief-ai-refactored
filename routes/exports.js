// routes/exports.js
// GET /exports/:id  → returns stored xlsx/pdf file
//
// Alignments:
// - Safer Content-Disposition filename handling (no header injection)
// - Stronger cache behavior + ETag + If-None-Match
// - Graceful handling of bytes being Buffer / Uint8Array / base64 string
// - Defensive pg.query resolution (some builds export query differently)

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const pg = require('../services/postgres');
const query = pg.query || pg.pool?.query || pg.db?.query;

function safeFilename(name) {
  const raw = String(name || 'export');
  // strip path-ish and control chars
  const cleaned = raw
    .replace(/[\r\n"]/g, '')
    .replace(/[\/\\]/g, '_')
    .replace(/[^\w.\- ()]/g, '_')
    .slice(0, 180);
  return cleaned || 'export';
}

function toBuffer(bytes) {
  if (!bytes) return Buffer.alloc(0);
  if (Buffer.isBuffer(bytes)) return bytes;
  // some pg drivers return Uint8Array
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  // sometimes stored as base64 string
  if (typeof bytes === 'string') {
    // try base64 first, then utf8
    try {
      const b = Buffer.from(bytes, 'base64');
      // heuristic: if decode produced something non-empty, accept it
      if (b.length) return b;
    } catch {}
    return Buffer.from(bytes, 'utf8');
  }
  // fallback
  try {
    return Buffer.from(bytes);
  } catch {
    return Buffer.alloc(0);
  }
}

router.get('/:id', async (req, res) => {
  try {
    if (!query) return res.status(500).send('DB not available');

    const { id } = req.params;

    // allow 16..64 hex id (matches your stored ids)
    if (!/^[a-f0-9]{16,64}$/i.test(String(id || ''))) {
      return res.status(400).send('Bad export id');
    }

    const r = await query(
      `SELECT filename, content_type, bytes
         FROM file_exports
        WHERE id=$1
        LIMIT 1`,
      [id]
    );

    if (!r?.rows?.length) return res.status(404).send('Not found');

    const row = r.rows[0] || {};
    const filename = safeFilename(row.filename);
    const contentType = String(row.content_type || 'application/octet-stream');

    const buf = toBuffer(row.bytes);
    if (!buf.length) return res.status(404).send('Not found');

    // ETag based on bytes
    const etag = crypto.createHash('sha1').update(buf).digest('hex');
    const quotedEtag = `"${etag}"`;

    res.set('Content-Type', contentType);

    const disp = req.query.download ? 'attachment' : 'inline';
    res.set('Content-Disposition', `${disp}; filename="${filename}"`);

    // Cache: safe to cache these immutable ids (you’re using content address / random id)
    res.set('Cache-Control', 'public, max-age=3600, immutable');
    res.set('ETag', quotedEtag);

    if (req.headers['if-none-match'] === quotedEtag) {
      return res.status(304).end();
    }

    res.set('Content-Length', String(buf.length));
    return res.status(200).send(buf);
  } catch (e) {
    console.error('[exports] error:', e?.message);
    return res.status(500).send('Server error');
  }
});

module.exports = router;
