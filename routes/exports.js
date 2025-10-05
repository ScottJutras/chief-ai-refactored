// routes/exports.js
const express = require('express');
const router = express.Router();
const { query } = require('../services/postgres');

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      `SELECT filename, content_type, bytes FROM file_exports WHERE id=$1 LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).send('Not found');

    const { filename, content_type, bytes } = rows[0];
    res.set('Content-Type', content_type);
    res.set('Content-Disposition', `inline; filename="${filename}"`);
    return res.status(200).send(bytes);
  } catch (e) {
    console.error('[ERROR] /exports/:id', e.message);
    return res.status(500).send('Server error');
  }
});

module.exports = router;
