// api/index.js
const { VercelRequest, VercelResponse } = require('@vercel/node');
const expressApp = require('../index'); // adjust path if necessary

module.exports = (req, res) => {
  expressApp(req, res);
};
