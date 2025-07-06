// after
const { db } = require('../services/firebase');


async function getUserTokenUsage(from, resetIfNewMonth = true) {
    const userRef = db.collection('users').doc(from);
    const userDoc = await userRef.get();
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;

    let usageData = userDoc.exists ? userDoc.data().tokenUsage || {} : {};
    if (resetIfNewMonth && (!usageData.lastReset || usageData.lastReset !== currentMonth)) {
        usageData = { messages: 0, aiCalls: 0, lastReset: currentMonth };
    }
    return usageData;
}

async function updateUserTokenUsage(from, usage) {
    const userRef = db.collection('users').doc(from);
    const usageData = await getUserTokenUsage(from);
    usageData.messages = (usageData.messages || 0) + (usage.messages || 0);
    usageData.aiCalls = (usageData.aiCalls || 0) + (usage.aiCalls || 0);
    await userRef.set({ tokenUsage: usageData }, { merge: true });
}

async function checkTokenLimit(from, subscriptionTier) {
    const usageData = await getUserTokenUsage(from);
    const limits = {
        'free': { messages: 0, aiCalls: 0 },
        'ai-assisted': { messages: 10000, aiCalls: 5000 },
        'advanced': { messages: 20000, aiCalls: 10000 },
        'pro': { messages: Infinity, aiCalls: Infinity }
    };
    const limit = limits[subscriptionTier.toLowerCase()] || limits['free'];
    return usageData.messages < limit.messages && usageData.aiCalls < limit.aiCalls;
}

async function getSubscriptionTier(userId) {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    return doc.data()?.subscriptionTier || 'free';
}

async function addPurchasedTokens(from, tokenCount) {
    const usageData = await getUserTokenUsage(from, false);
    const totalUsed = (usageData.messages || 0) + (usageData.aiCalls || 0);
    if (totalUsed === 0) return;
    const messageRatio = (usageData.messages || 0) / totalUsed;
    const aiCallRatio = (usageData.aiCalls || 0) / totalUsed;
    usageData.messages = Math.max(0, (usageData.messages || 0) - Math.round(tokenCount * messageRatio));
    usageData.aiCalls = Math.max(0, (usageData.aiCalls || 0) - Math.round(tokenCount * aiCallRatio));
    await db.collection('users').doc(from).set({ tokenUsage: usageData }, { merge: true });
}

module.exports = { getUserTokenUsage, updateUserTokenUsage, checkTokenLimit, getSubscriptionTier, addPurchasedTokens };