// api/exports/[id].js
const { getFileExport } = require('../../services/postgres');

module.exports = async (req, res) => {
  try {
    const id =
      (req.query && (req.query.id || req.query.slug)) ||
      (req.url && req.url.split('/').pop()) ||
      '';
    const cleanId = String(id || '').trim();
    if (!cleanId) {
      res.statusCode = 400;
      return res.end('Missing id');
    }

    const file = await getFileExport(cleanId);
    if (!file) {
      res.statusCode = 404;
      return res.end('Not found');
    }

    const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes || []);
    res.setHeader('Content-Type', file.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename || 'download'}"`);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

    return res.end(bytes);
  } catch (e) {
    console.error('[exports] failed:', e?.message);
    res.statusCode = 500;
    return res.end('Error');
  }
};
