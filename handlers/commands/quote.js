const { query, getActiveJob, saveJob } = require('../../services/postgres');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { parseQuoteMessage } = require('../../utils/aiErrorHandler');

async function saveQuote(ownerId, quoteData) {
  console.log(`[DEBUG] saveQuote called for ownerId: ${ownerId}, quoteData:`, quoteData);
  try {
    const res = await query(
      `INSERT INTO quotes (owner_id, job_name, customer_name, customer_email, subtotal, tax, total, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING id`,
      [
        ownerId,
        quoteData.jobName,
        quoteData.customerName,
        quoteData.customerEmail,
        quoteData.subtotal,
        quoteData.tax,
        quoteData.total,
        'Open/No Response'
      ]
    );
    console.log(`[DEBUG] saveQuote success, quote ID: ${res.rows[0].id}`);
    return res.rows[0].id;
  } catch (error) {
    console.error(`[ERROR] saveQuote failed for ${ownerId}:`, error.message);
    throw error;
  }
}

async function updateQuoteStatus(ownerId, quoteId, status) {
  console.log(`[DEBUG] updateQuoteStatus called for ownerId: ${ownerId}, quoteId: ${quoteId}, status: ${status}`);
  try {
    const res = await query(
      `UPDATE quotes
       SET status = $1, updated_at = NOW()
       WHERE owner_id = $2 AND id = $3
       RETURNING *`,
      [status, ownerId, quoteId]
    );
    console.log(`[DEBUG] updateQuoteStatus result:`, res.rows[0]);
    return res.rows.length > 0;
  } catch (error) {
    console.error(`[ERROR] updateQuoteStatus failed for ${ownerId}:`, error.message);
    return false;
  }
}

async function getMaterialPrices(ownerId) {
  console.log(`[DEBUG] getMaterialPrices called for ownerId: ${ownerId}`);
  try {
    const res = await query(
      `SELECT item_name, price FROM pricing_items WHERE owner_id = $1`,
      [ownerId]
    );
    const prices = {};
    res.rows.forEach(row => {
      prices[row.item_name.toLowerCase()] = row.price || 50; // Default price if not set
    });
    console.log(`[DEBUG] getMaterialPrices result:`, prices);
    return prices;
  } catch (error) {
    console.error(`[ERROR] getMaterialPrices failed for ${ownerId}:`, error.message);
    return {};
  }
}

function getTaxRate(country, province) {
  const taxRates = {
    'United States': { default: 0.08 },
    'Canada': {
      'Ontario': 0.13,
      'British Columbia': 0.12,
      'Alberta': 0.05,
      default: 0.13
    }
  };
  return country === 'United States'
    ? taxRates['United States'].default
    : taxRates['Canada'][province] || taxRates['Canada'].default;
}

async function buildQuoteDetails(quoteData, ownerProfile) {
  const materialPrices = await getMaterialPrices(ownerProfile.owner_id || ownerProfile.user_id);
  let subtotal = 0;
  let items = [];
  const isFixedPrice = !!quoteData.amount;

  if (isFixedPrice) {
    subtotal = quoteData.amount;
    items = [{ item: quoteData.description, quantity: 1, price: subtotal }];
  } else {
    items = quoteData.items.map(item => {
      const price = materialPrices[item.item.toLowerCase()] || 50;
      const itemTotal = item.quantity * price;
      subtotal += itemTotal;
      return { item: item.item, quantity: item.quantity, price, total: itemTotal };
    });
  }

  return {
    jobName: quoteData.jobName,
    items,
    subtotal,
    isFixedPrice
  };
}

async function handleQuote(from, input, userProfile, ownerId, ownerProfile, isOwner) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    if (!isOwner) {
      reply = `⚠️ Only the owner can generate quotes.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    const pendingState = await getPendingTransactionState(from);
    if (pendingState && pendingState.pendingQuote) {
      const customerInput = input.trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const customerName = emailRegex.test(customerInput) ? 'Email Provided' : customerInput;
      const customerEmail = emailRegex.test(customerInput) ? customerInput : null;
      const { jobName, items, subtotal, isFixedPrice, description } = pendingState.pendingQuote;

      const taxRate = getTaxRate(userProfile.country, userProfile.province);
      const tax = subtotal * taxRate;
      const total = subtotal + tax;
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';

      const quoteId = await saveQuote(ownerId, {
        jobName,
        customerName,
        customerEmail,
        subtotal,
        tax,
        total
      });

      await deletePendingTransactionState(from);
      reply = `✅ Quote for ${jobName} generated.\nSubtotal: ${currency} ${subtotal.toFixed(2)}\nTax (${(taxRate * 100).toFixed(2)}%): ${currency} ${tax.toFixed(2)}\nTotal: ${currency} ${total.toFixed(2)}\nCustomer: ${customerName}${customerEmail ? `\nEmail: ${customerEmail}` : ''}`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    const statusMatch = input.match(/^update quote\s+(\d+)\s+(open no response|open responded|closed win|closed lost)$/i);
    if (statusMatch) {
      const [, quoteId, status] = statusMatch;
      const normalizedStatus = status.toLowerCase().replace(/\s+/g, '/').replace('open/no/response', 'Open/No Response').replace('open/responded', 'Open/Responded').replace('closed/win', 'Closed/Win').replace('closed/lost', 'Closed/Lost');
      const success = await updateQuoteStatus(ownerId, quoteId, normalizedStatus);
      reply = success ? `✅ Quote ${quoteId} updated to ${normalizedStatus}.` : `⚠️ Quote ${quoteId} not found or update failed.`;
      if (normalizedStatus === 'Closed/Win') {
        const quote = await query(`SELECT job_name FROM quotes WHERE id = $1 AND owner_id = $2`, [quoteId, ownerId]);
        if (quote.rows[0]) {
          await setPendingTransactionState(from, { pendingJobCreation: { quoteId, jobName: quote.rows[0].job_name } });
          reply += `\nWould you like to start a new job for this quote? Reply 'yes' or 'no'.`;
        }
      }
      return `<Response><Message>${reply}</Message></Response>`;
    }

    if (pendingState && pendingState.pendingJobCreation) {
      const { quoteId, jobName } = pendingState.pendingJobCreation;
      const lcInput = input.toLowerCase().trim();
      if (lcInput === 'yes') {
        await saveJob(ownerId, jobName, new Date().toISOString());
        await deletePendingTransactionState(from);
        reply = `✅ Job ${jobName} started from quote ${quoteId}.`;
      } else if (lcInput === 'no') {
        await deletePendingTransactionState(from);
        reply = `Okay, no job created for quote ${quoteId}.`;
      } else {
        reply = `Please reply 'yes' or 'no' to confirm job creation for quote ${quoteId}.`;
      }
      return `<Response><Message>${reply}</Message></Response>`;
    }

    const quoteData = await parseQuoteMessage(input);
    if (!quoteData) {
      reply = `⚠️ Invalid quote format. Try: "quote $500 for Roof Repair to John" or "quote for Roof Repair with shingles 10 $50"`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    const quoteDetails = await buildQuoteDetails(quoteData, ownerProfile);
    await setPendingTransactionState(from, { pendingQuote: quoteDetails });
    const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
    reply = `📝 Quote prepared for ${quoteData.jobName}: ${currency} ${quoteDetails.total.toFixed(2)} for ${quoteDetails.description}.\nPlease provide the customer name or email to finalize.`;
    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleQuote failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process quote: ${error.message}`;
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    await require('../middleware/lock').releaseLock(lockKey);
  }
}

module.exports = { handleQuote };