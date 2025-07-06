console.log('[DEBUG] Current working directory:', process.cwd());
  try {
    const { db, admin } = require('./services/firebase');
    console.log('[SUCCESS] Firebase imported successfully:', !!db, !!admin);
  } catch (error) {
    console.error('[ERROR] Failed to import Firebase:', error.message);
  }