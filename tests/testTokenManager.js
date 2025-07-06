console.log('[DEBUG] Current working directory:', process.cwd());
  try {
    const { getUserTokenUsage } = require('../utils/tokenManager.js');
    console.log('[SUCCESS] tokenManager imported successfully');
  } catch (error) {
    console.error('[ERROR] Failed to import tokenManager:', error.message);
  }