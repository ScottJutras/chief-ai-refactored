const { db } = require('../services/firebase');

const getPendingTransactionState = async (from) => {
    const pendingDoc = await db.collection('pendingTransactions').doc(from).get();
    return pendingDoc.exists ? pendingDoc.data() : null;
};

const setPendingTransactionState = async (from, state) => {
    await db.collection('pendingTransactions').doc(from).set(state);
};

const deletePendingTransactionState = async (from) => {
    await db.collection('pendingTransactions').doc(from).delete();
};

module.exports = { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState };