const { Pool } = require('pg');
const { getActiveJob } = require('../services/postgres');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../utils/stateManager');
const { handleInputWithAI, parseBillMessage, detectErrors, categorizeEntry } = require('../utils/aiErrorHandler');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function saveBill(ownerId, billData) {
  console.log(`[DEBUG] saveBill called for ownerId: ${ownerId}, billData:`, billData);
  try {
    await pool.query(
      `INSERT INTO bills (owner_id, bill_name, amount, recurrence, category, date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [ownerId, billData.billName, parseFloat(billData.amount.replace('$', '')), billData.recurrence, billData.category, billData.date]
    );
    console.log(`[DEBUG] saveBill success for ${ownerId}`);
  } catch (error) {
    console.error(`[ERROR] saveBill failed for ${ownerId}:`, error.message);
    throw error;
  }
}

async function updateBill(ownerId, billData) {
  console.log(`[DEBUG] updateBill called for ownerId: ${ownerId}, billData:`, billData);
  try {
    const res = await pool.query(
      `UPDATE bills
       SET amount = COALESCE($1, amount),
           recurrence = COALESCE($2, recurrence),
           date = COALESCE($3, date),
           updated_at = NOW()
       WHERE owner_id = $4 AND bill_name = $5
       RETURNING *`,
      [billData.amount ? parseFloat(billData.amount.replace('$', '')) : null, billData.recurrence, billData.date, ownerId, billData.billName]
    );
    console.log(`[DEBUG] updateBill result:`, res.rows[0]);
    return res.rows.length > 0;
  } catch (error) {
    console.error(`[ERROR] updateBill failed for ${ownerId}:`, error.message);
    return false;
  }
}

async function deleteBill(ownerId, billName) {
  console.log(`[DEBUG] deleteBill called for ownerId: ${ownerId}, billName: ${billName}`);
  try {
    const res = await pool.query(
      `DELETE FROM bills WHERE owner_id = $1 AND bill_name = $2 RETURNING *`,
      [ownerId, billName]
    );
    console.log(`[DEBUG] deleteBill result:`, res.rows[0]);
    return res.rows.length > 0;
  } catch (error) {
    console.error(`[ERROR] deleteBill failed for ${ownerId}:`, error.message);
    return false;
  }
}

async function handleBill(from, input, userProfile, ownerId, ownerProfile, isOwner) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const pendingState = await getPendingTransactionState(from);
    if (pendingState && (pendingState.pendingBill || pendingState.pendingDelete?.type === 'bill')) {
      if (!isOwner) {
        await deletePendingTransactionState(from);
        reply = "⚠️ Only the owner can manage bills.";
        return `<Response><Message>${reply}</Message></Response>`;
      }

      const lcInput = input.toLowerCase().trim();
      if (lcInput === 'yes') {
        if (pendingState.pendingBill) {
          const { date, billName, amount, recurrence, suggestedCategory } = pendingState.pendingBill;
          const category = suggestedCategory || await categorizeEntry('bill', pendingState.pendingBill, ownerProfile);
          const activeJob = await getActiveJob(ownerId) || "Uncategorized";
          await saveBill(ownerId, { date, billName, amount, recurrence, category });
          await deletePendingTransactionState(from);
          reply = `✅ Bill logged: ${amount} for ${billName} (${recurrence}, Category: ${category})`;
        } else if (pendingState.pendingDelete?.type === 'bill') {
          const success = await deleteBill(ownerId, pendingState.pendingDelete.billName);
          await deletePendingTransactionState(from);
          reply = success
            ? `✅ Bill "${pendingState.pendingDelete.billName}" deleted.`
            : `⚠️ Bill "${pendingState.pendingDelete.billName}" not found or deletion failed.`;
        }
      } else if (lcInput === 'no' || lcInput === 'cancel') {
        await deletePendingTransactionState(from);
        reply = "❌ Operation cancelled.";
      } else if (lcInput === 'edit') {
        reply = "✏️ Okay, please resend the correct bill details (e.g., 'bill Truck Payment $760 monthly').";
        await setPendingTransactionState(from, { isEditing: true, type: 'bill' });
      } else {
        const target = pendingState.pendingBill || pendingState.pendingDelete;
        const errors = await detectErrors(target, 'bill');
        const category = pendingState.pendingBill ? await categorizeEntry('bill', pendingState.pendingBill, ownerProfile) : 'N/A';
        if (errors && pendingState.pendingBill) {
          const corrections = await correctErrorsWithAI(`Error in bill input: ${input} - ${JSON.stringify(errors)}`);
          if (corrections) {
            await setPendingTransactionState(from, {
              pendingBill: { ...pendingState.pendingBill, suggestedCategory: category },
              pendingCorrection: true,
              suggestedCorrections: corrections,
              type: 'bill'
            });
            const correctionText = Object.entries(corrections).map(([k, v]) => `${k}: ${target[k] || 'missing'} → ${v}`).join('\n');
            reply = `🤔 Issues detected:\n${correctionText}\nReply 'yes' to accept, 'no' to edit, or 'cancel' to discard.\nSuggested Category: ${category}`;
          } else {
            reply = `⚠️ Please respond with 'yes', 'no', 'edit', or 'cancel' to proceed.\nSuggested Category: ${category}`;
          }
        } else {
          reply = `⚠️ Please respond with 'yes', 'no', 'edit', or 'cancel' to proceed.`;
        }
        reply = pendingState.pendingBill
          ? `Please confirm: Bill "${pendingState.pendingBill.billName}" for ${userProfile.country === 'United States' ? 'USD' : 'CAD'} ${pendingState.pendingBill.amount} (${pendingState.pendingBill.recurrence})\n${reply}`
          : `Please confirm: Delete bill "${pendingState.pendingDelete.billName}"\n${reply}`;
      }
      return `<Response><Message>${reply}</Message></Response>`;
    }

    if (input.toLowerCase().startsWith("edit bill ")) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can edit bills.";
        return `<Response><Message>${reply}</Message></Response>`;
      }

      const match = input.match(/edit bill\s+(.+?)(?:\s+amount\s+(\$?\d+\.?\d*))?(?:\s+due\s+(.+?))?(?:\s+(yearly|monthly|weekly|bi-weekly|one-time))?/i);
      if (!match) {
        reply = "⚠️ Format: 'edit bill [name] amount $[X] due [date] [recurrence]' (e.g., 'edit bill Rent amount $600 due June 1st monthly')";
        return `<Response><Message>${reply}</Message></Response>`;
      }

      const [, billName, amount, dueDate, recurrence] = match;
      const billData = {
        billName,
        date: dueDate ? new Date(dueDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        amount: amount ? `$${parseFloat(amount.replace('$', '')).toFixed(2)}` : null,
        recurrence: recurrence || null
      };
      const success = await updateBill(ownerId, billData);
      reply = success
        ? `✅ Bill "${billName}" updated${amount ? ` to ${billData.amount}` : ''}${dueDate ? ` due ${dueDate}` : ''}${recurrence ? ` (${recurrence})` : ''}.`
        : `⚠️ Bill "${billName}" not found or update failed.`;
      return `<Response><Message>${reply}</Message></Response>`;
    } else if (input.toLowerCase().startsWith("delete bill ")) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can delete bills.";
        return `<Response><Message>${reply}</Message></Response>`;
      }

      const billName = input.replace(/^delete bill\s+/i, '').trim();
      if (!billName) {
        reply = "⚠️ Please provide a bill name. Try: 'delete bill Truck Payment'";
        return `<Response><Message>${reply}</Message></Response>`;
      }

      await setPendingTransactionState(from, { pendingDelete: { type: 'bill', billName } });
      reply = `Are you sure you want to delete bill '${billName}'? Reply 'yes' or 'no'.`;
      return `<Response><Message>${reply}</Message></Response>`;
    } else if (input.toLowerCase().includes("bill") && !input.toLowerCase().includes("delete")) {
      const defaultData = { date: new Date().toISOString().split('T')[0], billName: "Unknown", amount: "$0.00", recurrence: "one-time" };
      const { data, reply: aiReply, confirmed } = await handleInputWithAI(from, input, 'bill', parseBillMessage, defaultData);

      if (aiReply) {
        return `<Response><Message>${aiReply}</Message></Response>`;
      }

      if (data && data.billName && data.amount && data.amount !== "$0.00" && data.recurrence) {
        const validRecurrences = ['yearly', 'monthly', 'weekly', 'bi-weekly', 'one-time'];
        if (!validRecurrences.includes(data.recurrence.toLowerCase())) {
          reply = `⚠️ Invalid recurrence. Use: yearly, monthly, weekly, bi-weekly, or one-time.`;
          return `<Response><Message>${reply}</Message></Response>`;
        }
        const category = await categorizeEntry('bill', data, ownerProfile);
        await setPendingTransactionState(from, { pendingBill: { ...data, suggestedCategory: category } });
        reply = `Please confirm: Bill "${data.billName}" for ${userProfile.country === 'United States' ? 'USD' : 'CAD'} ${data.amount} (${data.recurrence})`;
        return `<Response><Message>${reply}</Message></Response>`;
      }

      reply = `🤔 Couldn’t parse a valid bill from "${input}". Try "bill Truck Payment $760 monthly".`;
      return `<Response><Message>${reply}</Message></Response>`;
    } else {
      reply = `⚠️ Invalid bill command. Try: 'bill Truck Payment $760 monthly', 'edit bill Rent amount $600 due June 1st monthly', or 'delete bill Truck Payment'.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }
  } catch (error) {
    console.error(`[ERROR] handleBill failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process bill command: ${error.message}`;
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    await require('../middleware/lock').releaseLock(lockKey);
  }
}

module.exports = { handleBill, saveBill, updateBill, deleteBill };