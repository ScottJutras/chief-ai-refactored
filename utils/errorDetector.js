const storeList = require('./storeList');

function detectErrors(data, type = 'expense') {
    const errors = [];

    if (type === 'expense' || type === 'revenue') {
        // Amount validation
        const amountNum = parseFloat(data.amount?.replace('$', '') || '0');
        if (amountNum <= 0) {
            errors.push({ field: 'amount', message: 'Amount is zero or negative', suggested: '$50.00' });
        } else if (amountNum > 10000) {
            errors.push({ field: 'amount', message: 'Amount seems unusually high', suggested: '$' + (amountNum / 10).toFixed(2) });
        }

        // Date validation
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(data.date)) {
            errors.push({ field: 'date', message: 'Invalid date format', suggested: new Date().toISOString().split('T')[0] });
        } else {
            const dataDate = new Date(data.date);
            const today = new Date();
            if (dataDate > today) {
                errors.push({ field: 'date', message: 'Date is in the future', suggested: today.toISOString().split('T')[0] });
            }
        }
    }

    if (type === 'expense') {
        // Store validation
        const storeLower = data.store?.toLowerCase().replace(/\s+/g, '');
        const isKnownStore = storeList.some(store => store.toLowerCase().replace(/\s+/g, '').includes(storeLower));
        if (!isKnownStore && data.store !== "Unknown Store") {
            const suggestedStore = storeList.find(store => store.toLowerCase().includes('home')) || 'Home Depot';
            errors.push({ field: 'store', message: 'Store not recognized', suggested: suggestedStore });
        }
    } else if (type === 'revenue') {
        // Client validation (example)
        if (!data.client || data.client.trim() === '') {
            errors.push({ field: 'client', message: 'Client is missing', suggested: 'Unknown Client' });
        }
    }

    return errors.length > 0 ? errors : null;
}

module.exports = { detectErrors };