const { saveExpense, getActiveJob, logTimeEntry } = require('./postgres');
const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;

const client = new DocumentProcessorServiceClient({
  credentials: JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString())
});

async function parseReceiptText(text) {
  console.log('[DEBUG] parseReceiptText called:', { text });
  try {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const amt = lines.find(l => l.match(/\$?\d+\.\d{2}/));
    const amount = amt ? amt.match(/\$?(\d+\.\d{2})/)?.[1] || '0.00' : '0.00';
    const store = lines.find(l => !l.match(/\$?\d+\.\d{2}/)) || 'Unknown';
    return { date: new Date().toISOString().split('T')[0], item: store, amount: `$${amount}`, store, category: 'Miscellaneous' };
  } catch (error) {
    console.error('[ERROR] parseReceiptText failed:', error.message);
    throw error;
  }
}

async function parseMediaText(text) {
  console.log('[DEBUG] parseMediaText called:', { text });
  try {
    const lcText = text.toLowerCase().trim();
    if (lcText.match(/(punch in|punch out|break start|break end|lunch start|lunch end|drive start|drive end)/i)) {
      const parts = lcText.split(' ');
      const employeeName = parts[0];
      const type = parts.slice(1).join(' ').match(/(punch in|punch out|break start|break end|lunch start|lunch end|drive start|drive end)/i)?.[1]?.replace(' ', '_').toLowerCase();
      const timeMatch = lcText.match(/at\s+(\d{1,2}(?::\d{2})?\s*(am|pm))/i);
      const timestamp = timeMatch ? new Date(`${new Date().toISOString().split('T')[0]} ${timeMatch[1]}`) : new Date();
      if (!employeeName || !type || isNaN(timestamp)) {
        throw new Error('Invalid time entry format');
      }
      return { type: 'time_entry', data: { employeeName, type, timestamp: timestamp.toISOString() } };
    } else if (lcText.match(/\$?\d+\.\d{2}/)) {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const amt = lines.find(l => l.match(/\$?\d+\.\d{2}/));
      const amount = amt ? amt.match(/\$?(\d+\.\d{2})/)?.[1] || '0.00' : '0.00';
      const store = lines.find(l => !l.match(/\$?\d+\.\d{2}/)) || 'Unknown';
      return { type: 'expense', data: { date: new Date().toISOString().split('T')[0], item: store, amount: `$${amount}`, store, category: 'Miscellaneous' } };
    } else {
      const parts = lcText.split(' from ');
      if (parts.length > 1 && parts[0].match(/\$?\d+\.\d{2}/)) {
        const amount = parts[0].match(/\$?(\d+\.\d{2})/)?.[1] || '0.00';
        const source = parts[1].trim() || 'Unknown';
        return { type: 'revenue', data: { date: new Date().toISOString().split('T')[0], description: source, amount: `$${amount}`, source, category: 'Service' } };
      }
      throw new Error('Invalid media format');
    }
  } catch (error) {
    console.error('[ERROR] parseMediaText failed:', error.message);
    throw error;
  }
}

async function handleReceiptImage(phoneNumber, text, mediaUrl, mediaType) {
  console.log('[DEBUG] handleReceiptImage called:', { phoneNumber, text, mediaUrl, mediaType });
  try {
    const name = `projects/${process.env.GCP_PROJECT_ID}/locations/us/processors/${process.env.DOCUMENTAI_PROCESSOR_ID}`;
    const request = {
      name,
      rawDocument: {
        content: Buffer.isBuffer(mediaUrl) ? mediaUrl.toString('base64') : await (await require('axios').get(mediaUrl, { responseType: 'arraybuffer' })).data.toString('base64'),
        mimeType: mediaType
      }
    };
    const [result] = await client.processDocument(request);
    const { document } = result;
    const parsed = {
      date: document.entities.find(e => e.type === 'date')?.normalizedValue?.dateValue || new Date().toISOString().split('T')[0],
      item: document.entities.find(e => e.type === 'item')?.text || 'Unknown',
      amount: document.entities.find(e => e.type === 'total_amount')?.normalizedValue?.moneyValue?.amount || '0.00',
      store: document.entities.find(e => e.type === 'supplier_name')?.text || 'Unknown',
      category: 'Miscellaneous'
    };
    const jobName = await getActiveJob(phoneNumber) || 'Uncategorized';
    await saveExpense({
      ownerId: phoneNumber,
      date: parsed.date,
      item: parsed.item,
      amount: `$${parsed.amount}`,
      store: parsed.store,
      jobName,
      category: parsed.category,
      user: 'Unknown',
      media_url: mediaUrl
    });
    return `✅ Logged expense ${parsed.amount} for ${parsed.item} from ${parsed.store}`;
  } catch (error) {
    console.error('[ERROR] handleReceiptImage failed for', phoneNumber, ':', error.message);
    throw error;
  }
}

module.exports = { parseReceiptText, parseMediaText, handleReceiptImage };