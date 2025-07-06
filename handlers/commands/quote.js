const { parseQuoteMessage, buildQuoteDetails } = require('../../utils/quoteUtils');
const { generateQuotePDF } = require('../../utils/pdfService');
const { sendEmail } = require('../../utils/sendGridService');
const { getTaxRate } = require('../../utils/taxRate');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { uploadFile, setFilePermissions } = require('../../services/drive');
const { fetchMaterialPrices } = require('../../services/postgres.js');
const { db } = require('../../services/firebase');
const fs = require('fs').promises;

async function handleQuote(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    // Ensure only the owner can generate quotes
    if (!isOwner) {
      reply = `⚠️ Only the owner can generate quotes.`;
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (not owner)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Check for pending quote confirmation
    const pendingState = await getPendingTransactionState(from);
    if (pendingState && pendingState.pendingQuote) {
      const customerInput = input.trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const customerName = emailRegex.test(customerInput) ? 'Email Provided' : customerInput;
      const customerEmail = emailRegex.test(customerInput) ? customerInput : null;
      const { jobName, items, total, isFixedPrice, description } = pendingState.pendingQuote;

      // Calculate tax and total
      const taxRate = getTaxRate(userProfile.country, userProfile.province);
      const subtotal = total;
      const tax = subtotal * taxRate;
      const totalWithTax = subtotal + tax;
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';

      // Generate PDF
      const outputPath = `/tmp/quote_${from}_${Date.now()}.pdf`;
      const quoteData = {
        jobName,
        items: isFixedPrice ? [{ item: description, quantity: 1, price: subtotal }] : items,
        subtotal,
        tax,
        total: totalWithTax,
        customerName,
        contractorName: ownerProfile.name || 'Your Company Name',
        companyName: ownerProfile.companyName || '',
        hstNumber: ownerProfile.hstNumber || '',
        companyAddress: ownerProfile.companyAddress || '',
        companyPhone: ownerProfile.companyPhone || '',
        logoUrl: ownerProfile.logoUrl || '',
        paymentTerms: ownerProfile.paymentTerms || 'Due upon receipt',
        specialMessage: ownerProfile.specialMessage || 'Thank you for your business!'
      };
      await generateQuotePDF(quoteData, outputPath);

      // Upload to Google Drive
      const fileName = `Quote_${jobName}_${Date.now()}.pdf`;
      const driveResponse = await uploadFile(fileName, 'application/pdf', fs.createReadStream(outputPath));
      await setFilePermissions(driveResponse.id, 'reader', 'anyone');
      const pdfUrl = driveResponse.webViewLink;

      // Store quote in Firestore
      const quoteRef = await db.collection('users').doc(ownerId).collection('quotes').add({
        jobName,
        customerName,
        customerEmail,
        subtotal,
        tax,
        total: totalWithTax,
        status: 'Open/No Response',
        createdAt: new Date().toISOString(),
        pdfUrl
      });

      // Clean up state
      await deletePendingTransactionState(from);

      // Prepare response
      reply = `✅ Quote for ${jobName} generated.\nSubtotal: ${currency} ${subtotal.toFixed(2)}\nTax (${(taxRate * 100).toFixed(2)}%): ${currency} ${tax.toFixed(2)}\nTotal: ${currency} ${totalWithTax.toFixed(2)}\nCustomer: ${customerName}\nDownload here: ${pdfUrl}`;
      if (customerEmail) {
        await sendEmail(customerEmail, `Your Quote for ${jobName}`, `Please find your quote attached.`, pdfUrl);
        reply += `\nAlso sent to ${customerEmail}`;
      }

      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (pending quote processed)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Handle quote status updates
    const statusMatch = input.match(/^update quote\s+(.+?)\s+(open no response|open responded|closed win|closed lost)$/i);
    if (statusMatch) {
      const [, quoteId, status] = statusMatch;
      const normalizedStatus = status.toLowerCase().replace(/\s+/g, '/').replace('open/no/response', 'Open/No Response').replace('open/responded', 'Open/Responded').replace('closed/win', 'Closed/Win').replace('closed/lost', 'Closed/Lost');
      await db.collection('users').doc(ownerId).collection('quotes').doc(quoteId).update({
        status: normalizedStatus,
        updatedAt: new Date().toISOString()
      });
      reply = `✅ Quote ${quoteId} updated to ${normalizedStatus}.`;
      if (normalizedStatus === 'Closed/Win') {
        reply += `\nWould you like to start a new job for this quote? Reply 'yes' or 'no'.`;
        await setPendingTransactionState(from, { pendingJobCreation: { quoteId, jobName: (await db.collection('users').doc(ownerId).collection('quotes').doc(quoteId).get()).data().jobName } });
      }
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (quote status updated)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Handle job creation from closed/won quote
    if (pendingState && pendingState.pendingJobCreation) {
      const { quoteId, jobName } = pendingState.pendingJobCreation;
      if (input.toLowerCase() === 'yes') {
        await db.collection('users').doc(ownerId).set({
          activeJob: jobName,
          jobHistory: admin.firestore.FieldValue.arrayUnion({
            jobName,
            startTime: new Date().toISOString(),
            status: 'active'
          })
        }, { merge: true });
        await deletePendingTransactionState(from);
        reply = `✅ Job ${jobName} started from quote ${quoteId}.`;
      } else if (input.toLowerCase() === 'no') {
        await deletePendingTransactionState(from);
        reply = `Okay, no job created for quote ${quoteId}.`;
      } else {
        reply = `Please reply 'yes' or 'no' to confirm job creation for quote ${quoteId}.`;
      }
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (job creation response)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Handle new quote from input
    const quoteData = parseQuoteMessage(input);
    if (!quoteData) {
      reply = `⚠️ Invalid quote format. Try: 'quote [amount] for [description] to [client]' or 'quote for [jobName] with [item1 qty price, item2 qty price]'`;
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (invalid quote)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Fetch material prices for detailed quotes
    const pricingSpreadsheetId = ownerProfile.pricingSpreadsheetId || process.env.DEFAULT_PRICING_SPREADSHEET_ID;
    const materialPrices = await fetchMaterialPrices(pricingSpreadsheetId);
    const quoteDetails = await buildQuoteDetails(quoteData, ownerProfile, materialPrices);

    // Store pending quote state
    await setPendingTransactionState(from, { pendingQuote: quoteDetails });
    reply = `📝 Quote prepared for ${quoteData.jobName}: ${currency} ${quoteDetails.total.toFixed(2)} for ${quoteDetails.description}.\nPlease provide the customer name or email to finalize.`;
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (quote prepared)`);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (err) {
    console.error(`Error in handleQuote: ${err.message}`);
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (error)`);
    return res.send(`<Response><Message>⚠️ Failed to process quote: ${err.message}</Message></Response>`);
  }
}

module.exports = { handleQuote };