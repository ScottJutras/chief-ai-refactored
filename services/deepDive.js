const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;
const { Pool } = require('pg');
const csvParser = require('csv-parser');
const stream = require('stream');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const client = new DocumentProcessorServiceClient({
  credentials: JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString())
});

async function parseUpload(buffer, filename, from, mimeType, uploadType = 'csv', fiscalYearStart) {
  const MAX_TRANSACTIONS = {
    starter: 5000,
    pro: 20000,
    enterprise: 50000
  };
  try {
    const userRes = await pool.query(`SELECT * FROM users WHERE phone = $1`, [from]);
    const userProfile = userRes.rows[0];
    if (!userProfile) throw new Error('User not found');
    const tier = userProfile.subscription_tier || 'starter';
    const maxTransactions = MAX_TRANSACTIONS[tier];
    const fiscalYear = new Date(fiscalYearStart || '2025-01-01');
    const fiscalYearEnd = new Date(fiscalYear.getFullYear() + 1, fiscalYear.getMonth(), fiscalYear.getDate() - 1);
    let transactions = [];
    if (uploadType === 'csv' && ['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(mimeType)) {
      const results = [];
      const bufferStream = new stream.PassThrough();
      bufferStream.end(buffer);
      await new Promise((resolve, reject) => {
        bufferStream
          .pipe(csvParser())
          .on('data', (data) => results.push(data))
          .on('end', resolve)
          .on('error', reject);
      });
      transactions = results.map(row => ({
        date: row.date || new Date().toISOString().split('T')[0],
        amount: parseFloat(row.amount?.replace('$', '') || '0'),
        description: row.description || 'Unknown',
        category: row.category || 'Other'
      }));
    } else if (['application/pdf', 'image/jpeg', 'image/png', 'audio/mpeg'].includes(mimeType)) {
      const name = `projects/${process.env.GCP_PROJECT_ID}/locations/us/processors/${process.env.DOCUMENTAI_PROCESSOR_ID}`;
      const request = { name, rawDocument: { content: buffer, mimeType } };
      const [result] = await client.processDocument(request);
      const { document } = result;
      if (document.entities) {
        for (const entity of document.entities) {
          if (entity.type === 'transaction') {
            const transactionDate = entity.properties.find(p => p.type === 'date')?.normalizedValue?.text || new Date().toISOString().split('T')[0];
            const date = new Date(transactionDate);
            if (date < fiscalYear || date > fiscalYearEnd) {
              if (!userProfile.historical_parsing_purchased) {
                throw new Error('Historical image/audio parsing requires DeepDive purchase. Reply "upload history" for payment link.');
              }
            }
            transactions.push({
              date: transactionDate,
              amount: entity.properties.find(p => p.type === 'amount')?.mentionText || '0',
              description: entity.properties.find(p => p.type === 'description')?.mentionText || 'Unknown',
              category: entity.properties.find(p => p.type === 'category')?.mentionText || 'Other'
            });
          }
        }
      }
    } else {
      throw new Error('Unsupported file type. Use CSV, Excel, PDF, image, or audio.');
    }
    if (transactions.length > maxTransactions) {
      throw new Error(`Upload exceeds ${maxTransactions} transactions for ${tier} tier.`);
    }
    const values = transactions.flatMap(t => [
      userProfile.owner_id, t.date, t.amount, t.description, t.category, new Date().toISOString()
    ]);
    const placeholders = transactions.map((_, i) => `($${i*6+1}, $${i*6+2}, $${i*6+3}, $${i*6+4}, $${i*6+5}, $${i*6+6})`).join(',');
    await pool.query(
      `INSERT INTO transactions (owner_id, date, amount, description, category, created_at) VALUES ${placeholders}`,
      values
    );
    return {
      transactions: transactions.length,
      summary: `Processed ${transactions.length} transactions from ${filename}.`
    };
  } catch (err) {
    console.error(`[ERROR] parseUpload failed for ${from}:`, err.message);
    throw new Error(`Upload processing failed: ${err.message}`);
  }
}
module.exports = { parseUpload };