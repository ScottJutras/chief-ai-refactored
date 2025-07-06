// firebase.js
const admin = require('firebase-admin');

// Load Firebase credentials from base64 environment variable
const firebaseCredentialsBase64 = process.env.FIREBASE_CREDENTIALS_BASE64;

if (!firebaseCredentialsBase64) {
    console.error("[ERROR] FIREBASE_CREDENTIALS_BASE64 is not set in environment variables.");
    process.exit(1);
}

if (!admin.apps.length) {
    try {
        const firebaseCredentials = JSON.parse(
            Buffer.from(firebaseCredentialsBase64, 'base64').toString('utf-8')
        );
        admin.initializeApp({
            credential: admin.credential.cert(firebaseCredentials),
        });
        console.log("[✅] Firebase Admin initialized successfully.");
    } catch (error) {
        console.error("[ERROR] Failed to initialize Firebase Admin:", error.message);
        process.exit(1);
    }
}

const db = admin.firestore();

module.exports = { db, admin }; // Export db and admin for flexibility
