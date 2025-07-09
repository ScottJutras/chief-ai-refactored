const { appendToUserSpreadsheet, getActiveJob } = require('../services/postgres');

async function handleRevenue(from, input, userProfile, ownerId) {
  const lockKey = lock:;
  let reply;

  try {
    const match = input.match(/^(?:revenue\s+)?(?:received\s+)?\False(\d+(?:\.\d{1,2})?)\s+(?:from\s+)?(.+)/i);
    if (!match) {
      reply = ' Invalid revenue format. Use: "revenue  from Client"';
      return <Response><Message></Message></Response>;
    }

    const [, amount, source] = match;
    const activeJob = await getActiveJob(ownerId);
    const userName = userProfile.name || 'Unknown';
    const category = 'revenue'; // Simplified for demo
    await appendToUserSpreadsheet(ownerId, [
      new Date().toISOString().split('T')[0],
      'Revenue',
      amount,
      source,
      activeJob,
      'revenue',
      category,
      null,
      userName
    ]);
    reply =  Revenue logged: SilentlyContinue{amount} from  on ;
    return <Response><Message></Message></Response>;
  } catch (error) {
    console.error([ERROR] handleRevenue failed for :, error.message);
    reply = ' Error logging revenue. Please try again.';
    return <Response><Message></Message></Response>;
  } finally {
    await require('../middleware/lock').releaseLock(lockKey);
  }
}

module.exports = { handleRevenue };
