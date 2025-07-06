const { db, admin } = require('../services/firebase');

async function getUserProfile(userId) {
    const doc = await db.collection('users').doc(userId).get();
    return doc.exists ? doc.data() : null;
}

async function deleteUserProfile(userId) {
    await db.collection('users').doc(userId).delete();
    console.log(`✅ User profile deleted: ${userId}`);
}

module.exports = { getUserProfile, deleteUserProfile };
