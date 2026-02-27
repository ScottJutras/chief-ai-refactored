// api/index.js
// Vercel Serverless entrypoint: export the Express app from the repo root.

const app = require("../index"); // <- your root index.js that mounts routers
module.exports = app;