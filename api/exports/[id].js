// api/exports/[id].js
// Vercel serverless endpoint to stream a stored export by id

const { getFileExport } = require('../../services/postgres');

module.exports = async (req, res) => {
  try {
    const id = (req.query?.id || req.query?.slug || req.url.split('/').pop() || '').trim();
    if (!id) {
      res.statusCode = 400;
      return res.end('Missing id');
    }

    const file = await getFileExport(id);
    if (!file) {
      res.statusCode = 404;
      return res.end('Not found');
    }

    res.setHeader('Content-Type', file.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename || 'download'}"`);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

    // file.bytes is a Buffer from Postgres (bytea)
    return res.end(file.bytes);
  } catch (e) {
    console.error('[exports] failed:', e?.message);
    res.statusCode = 500;
    return res.end('Error');
  }
};
