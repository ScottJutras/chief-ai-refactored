console.log('[DEBUG] Current working directory:', process.cwd());
  try {
    const { saveState } = require('../utils/stateManager.js');
    console.log('[SUCCESS] stateManager imported successfully');
  } catch (error) {
    console.error('[ERROR] Failed to import stateManager:', error.message);
  }