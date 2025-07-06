const { db } = require('../../services/firebase');
const { releaseLock } = require('../../middleware/lock');
const { parseReceiptQuery } = require('../../services/openAI');

async function handleReceipt(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const query = await parseReceiptQuery(input);
    if (!query.item) {
      reply = "⚠️ Please specify an item to search for. Try: 'find receipt for Hammer'";
      await releaseLock(lockKey);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    const snapshot = await db.collection('users').doc(ownerId).collection('expenses')
      .where('item', '>=', query.item.toLowerCase())
      .where('item', '<=', query.item.toLowerCase() + '\uf8ff')
      .get();

    const receipts = snapshot.docs.filter(doc => doc.data().mediaUrl);
    if (!receipts.length) {
      reply = `🤔 No receipts found for "${query.item}". Try a different item or check your expenses.`;
      await releaseLock(lockKey);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    reply = `📄 Found ${receipts.length} receipt${receipts.length > 1 ? 's' : ''} for "${query.item}":\n`;
    receipts.slice(0, 3).forEach((doc, i) => {
      const data = doc.data();
      reply += `${i + 1}. ${data.date} - ${data.amount} from ${data.store}\nLink: ${data.mediaUrl}\n`;
    });
    if (receipts.length > 3) reply += `...and ${receipts.length - 3} more. Refine your search for more details.`;

    await releaseLock(lockKey);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (error) {
    console.error(`Error in handleReceipt: ${error.message}`);
    await releaseLock(lockKey);
    throw error;
  }
}

module.exports = { handleReceipt };