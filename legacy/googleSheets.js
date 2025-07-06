// ─── IMPORTS ────────────────────────────────────────────────────────────────
const { google } = require('googleapis');
const { db, admin } = require('./firebase');
const { sendSpreadsheetEmail } = require("../utils/sendGridService"); // Import SendGrid function
const { getAuthorizedClient } = require('../utils/auth');

// ─── FIREBASE ADMIN / FIRESTORE SETUP ─────────────────────────────────────────

/**
 * Retrieves the user's profile from Firestore.
 *
 * @param {string} phoneNumber - The user's WhatsApp number.
 * @returns {Promise<Object|null>} The user profile data or null if not found.
 */
async function getUserProfile(phoneNumber) {
  try {
    const formattedNumber = phoneNumber.replace(/\D/g, ""); // Normalize phone number
    const possibleFormats = [formattedNumber, `whatsapp:+${formattedNumber}`];

    let userProfile = null;

    for (const format of possibleFormats) {
      const userRef = db.collection("users").doc(format);
      const doc = await userRef.get();

      if (doc.exists) {
        userProfile = doc.data();
        console.log(`[✅] Retrieved user profile for ${format}:`, userProfile);

        // If onboarding is still in progress, return the profile
        if (userProfile.onboarding_in_progress !== false) {
          return userProfile;
        } else {
          console.log(`[ℹ️] User ${phoneNumber} has already completed onboarding.`);
          return userProfile; // Ensure it still returns the profile
        }
      }
    }

    console.log(`[ℹ️] No user profile found for ${phoneNumber}`);
    return null;
  } catch (error) {
    console.error("[❌] Error fetching user profile:", error);
    return null;
  }
}


/**
 * Converts an amount string (e.g. "$1456.00") to a numeric value.
 * Multiplies by -1 for expenses or bills.
 *
 * @param {string|number} amount - The amount string or number.
 * @param {string} type - One of "revenue", "expense", or "bill".
 * @returns {string} The formatted amount as a string (e.g., "-$1456.00").
 */
function formatAmount(amount, type) {
    // Ensure amount is a string
    let amountStr = String(amount);
    // Remove non-numeric characters (except . and -), default to 0 if invalid
    let num = parseFloat(amountStr.replace(/[^0-9.-]+/g, '')) || 0;
    // Apply sign based on type
    if (type === 'expense' || type === 'bill') {
        num = -Math.abs(num); // Ensure negative for expenses/bills
    } else {
        num = Math.abs(num); // Ensure positive for revenue
    }
    // Return as formatted string
    return `$${num.toFixed(2)}`;
}

async function saveUserProfile(userProfile) {
  try {
    const formattedNumber = userProfile.user_id.replace(/\D/g, ""); // Normalize to digits only

    console.log(`[DEBUG] Checking user profile for: ${formattedNumber}`);

    const userRef = db.collection("users").doc(formattedNumber);

    // Ensure onboarding is marked as complete
    userProfile.onboarding_in_progress = false;

    // ✅ Add subscription_tier if it doesn't exist (default to "basic")
    if (!userProfile.subscription_tier) {
      userProfile.subscription_tier = "basic";  // Default tier
    }

    await userRef.set(userProfile, { merge: true });

    console.log(`[✅ SUCCESS] User profile saved for ${formattedNumber} with subscription tier: ${userProfile.subscription_tier}`);
  } catch (error) {
    console.error("[❌ ERROR] Failed to save user profile:", error);
    throw error;
  }
}



// ─── GOOGLE CREDENTIALS & AUTH SETUP ───────────────────────────────────────────
if (!process.env.GOOGLE_CREDENTIALS_BASE64) {
  throw new Error("[ERROR] GOOGLE_CREDENTIALS_BASE64 is missing. Cannot authenticate Google Sheets API.");
}
const googleCredentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
);

// Scopes required for Sheets and Drive.
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive'        // Ensure full sharing permissions
];

// ─── REVENUE LOGGING ─────────────────────────────────────────────────────────
async function logRevenueEntry(ownerId, revenueData) {
  const { date, description, amount, source, job, category } = revenueData;
  const auth = await getAuthorizedClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const userProfile = await getUserProfile(ownerId);
  await sheets.spreadsheets.values.append({
      spreadsheetId: userProfile.spreadsheetId,
      range: 'Revenue!A:I',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[date, description, amount, source, job, 'revenue', category, '', userProfile.name]] }
    });
  try {
      // Ensure the sheet exists, create if necessary
      await ensureSheetExists(sheets, spreadsheetId, sheetName);

      // Use formatAmount to handle string-to-number conversion and formatting
      const formattedAmount = formatAmount(amount, 'revenue'); // Returns "$500.00" for revenue

      const values = [[date, source, formattedAmount, category, paymentMethod, notes]];
      await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `${sheetName}!A:F`,
          valueInputOption: 'USER_ENTERED',
          resource: { values }
      });

      console.log(`[✅] Revenue logged: ${formattedAmount} from ${source} on ${date}`);
      return true;
  } catch (error) {
      console.error("Error logging revenue entry:", error.message);
      throw error;
  }
}
async function suggestDeductions(userId, { description, category }) {
  return `Deduction: ${category} (${description})`; // Placeholder
}

async function ensureSheetExists(sheets, spreadsheetId, sheetName) {
  try {
    const response = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetExists = response.data.sheets.some(sheet => sheet.properties.title === sheetName);
    
    if (!sheetExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
          requests: [{
            addSheet: { properties: { title: sheetName } }
          }]
        }
      });
      console.log(`Sheet '${sheetName}' created.`);
    }
  } catch (error) {
    console.error('Error ensuring sheet exists:', error);
  }
}
// ─── SPREADSHEET CREATION & RETRIEVAL ─────────────────────────────────────────
/**
 * Creates a new spreadsheet for a user using the Google Sheets API.
 * The spreadsheet is created with one sheet ("Sheet1") that includes header values.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @param {string} userEmail - The user's email (optional, can be fetched from Firestore).
 * @returns {Promise<string>} The spreadsheet ID.
 */
async function createSpreadsheetForUser(phoneNumber, userEmail = null) {
  try {
    console.log(`[DEBUG] Creating a new spreadsheet for user: ${phoneNumber}`);

    const auth = await getAuthorizedClient();
    const sheets = google.sheets({ version: "v4", auth });
    const drive = google.drive({ version: "v3", auth });

    // Step 1: Create a new spreadsheet
    const response = await sheets.spreadsheets.create({
      resource: {
        properties: { title: `Expenses - ${phoneNumber}` },
        sheets: [
          {
            properties: { title: "Sheet1" },
            data: {
              rowData: [
                {
                  values: [
                    { userEnteredValue: { stringValue: "Date" } },
                    { userEnteredValue: { stringValue: "Item" } },
                    { userEnteredValue: { stringValue: "Amount" } },
                    { userEnteredValue: { stringValue: "Store" } },
                    { userEnteredValue: { stringValue: "Job" } },
                  ],
                },
              ],
            },
          },
        ],
      },
      fields: "spreadsheetId",
    });

    const spreadsheetId = response.data.spreadsheetId;
    console.log(`[✅ SUCCESS] Spreadsheet created: ${spreadsheetId}`);

    // Step 2: Retrieve the user's email from Firestore if not provided
    let emailToUse = userEmail;
    if (!emailToUse) {
      const userProfile = await getUserProfile(phoneNumber);
      emailToUse = userProfile?.email || process.env.FALLBACK_EMAIL; // Use Firestore email or fallback
    }

    if (!emailToUse) {
      console.error(`[ERROR] No email found for user ${phoneNumber}. Cannot share the spreadsheet.`);
      throw new Error(`No valid email found for user: ${phoneNumber}`);
    }

    // Step 3: Share the spreadsheet publicly
    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: {
        role: "writer",
        type: "anyone", // Allows access without a Google account
      },
    });

    console.log(`[✅ SUCCESS] Spreadsheet shared publicly: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
  } catch (error) {
    console.error(`[❌ ERROR] Failed to create and share spreadsheet:`, error.message);
    throw new Error(`Spreadsheet creation failed: ${error.message}`);
  }
}

/**
 * Retrieves (from Firestore) or creates a new spreadsheet for a user.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @returns {Promise<{spreadsheetId: string, userEmail: string}>} The spreadsheet ID and user email.
 */
async function getOrCreateUserSpreadsheet(phoneNumber) {
  try {
    const formattedNumber = phoneNumber.replace(/\D/g, ""); // Normalize to digits only
    const userDocRef = db.collection('users').doc(formattedNumber);
    const doc = await userDocRef.get();

    if (!doc.exists) {
      console.error(`[❌ ERROR] No Firestore entry found for ${formattedNumber}`);
      throw new Error("User not found in Firestore.");
    }

    const userProfile = doc.data();

    if (!userProfile || !userProfile.email) {
      console.error(`[❌ ERROR] No email found for ${formattedNumber}. Cannot create a spreadsheet.`);
      throw new Error("User email is required but missing.");
    }

    const userEmail = userProfile.email;
    let spreadsheetId = userProfile.spreadsheetId;

    if (!spreadsheetId) {
      console.log(`[DEBUG] No spreadsheet found for user (${formattedNumber}). Creating a new one.`);

      // Pass the email to createSpreadsheetForUser
      spreadsheetId = await createSpreadsheetForUser(formattedNumber, userEmail);

      // Save new spreadsheet ID to Firestore
      await userDocRef.set({ spreadsheetId }, { merge: true });

      console.log(`[✅ SUCCESS] Spreadsheet created and saved to Firebase for user (${formattedNumber}): ${spreadsheetId}`);
    }

    return { spreadsheetId, userEmail };
  } catch (error) {
    console.error(`[❌ ERROR] Failed to retrieve or create spreadsheet for user (${phoneNumber}):`, error.message);
    throw error;
  }
}
/**
 * Append an entry to the user's spreadsheet and handle budgeting/goals/alerts.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @param {Array} rowData - [Date, Item, Amount, Store/Recurrence/Source, Job, Type, Category, MediaUrl?, UserName?]
 * @returns {string} - Reply message for WhatsApp
 */
async function appendToUserSpreadsheet(phoneNumber, rowData) {
  try {
      const { spreadsheetId, userEmail } = await getOrCreateUserSpreadsheet(phoneNumber);
      if (!spreadsheetId) throw new Error(`[ERROR] No spreadsheet ID for ${phoneNumber}`);

      const auth = await getAuthorizedClient();
      const sheets = google.sheets({ version: 'v4', auth });
      const userProfile = await getUserProfile(phoneNumber);
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';

      // Handle variable rowData length (some calls pass 9, some 7)
      const [date, item, amount, source, job, type, category, mediaUrl = '', userName = ''] = rowData;
      const amountNum = parseFloat(amount.replace(/[^0-9.]/g, ''));
      const formattedAmount = `${currency} ${amountNum.toFixed(2)}`;
      const values = [[date, item, formattedAmount, source, job, type, category || ""]];

      // Append to Sheet1
      await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: 'Sheet1!A:G',
          valueInputOption: 'USER_ENTERED',
          resource: { values }
      });
      console.log(`[✅ SUCCESS] Sheet1 appended: ${JSON.stringify(values[0])}`);

      let reply = `✅ ${type} logged: ${formattedAmount} ${type === 'expense' ? `for ${item}` : type === 'revenue' ? `from ${source}` : `for ${item}`}`;

      // Bill Forecasting
      if (type === 'bill') {
          const recurrenceMap = { 'yearly': 1, 'monthly': 12, 'weekly': 52, 'bi-weekly': 26, 'one-time': 0 };
          const annualCost = amountNum * (recurrenceMap[source] || 1); // source is recurrence for bills
          await sheets.spreadsheets.values.append({
              spreadsheetId,
              range: 'Budget!A:D',
              valueInputOption: 'RAW',
              resource: { values: [[date, item, formattedAmount, `${source} - ${currency} ${annualCost.toFixed(2)}/yr`]] }
          });
          reply += `. Added to budget: ${currency} ${annualCost.toFixed(2)}/yr`;
          console.log(`[✅ SUCCESS] Budget appended: ${item}, ${annualCost}/yr`);
      }

      // Goal Tracking
      const profitImpact = type === 'revenue' ? amountNum : (type === 'expense' || type === 'bill') ? -amountNum : 0;
      userProfile.goalProgress = userProfile.goalProgress || { target: 10000, current: 0 };
      userProfile.goalProgress.current += profitImpact;
      await setUserProfile(phoneNumber, userProfile);
      console.log(`[✅ SUCCESS] Goal updated: ${userProfile.goalProgress.current}/${userProfile.goalProgress.target}`);

      // Alerts (simplified for now—full expenses fetch could be optimized)
      if (type === 'expense' || type === 'bill') {
          const budgetRows = (await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Budget!A:D' })).data.values?.slice(1) || [];
          const monthlyBudget = budgetRows.reduce((sum, [, , amt]) => sum + parseFloat(amt.replace(/[^0-9.]/g, '')) / 12, 0);
          const expenses = (await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Sheet1!A:G' })).data.values?.slice(1) || [];
          const spentThisMonth = expenses
              .filter(e => e[5] === 'expense' || e[5] === 'bill')
              .filter(e => e[0].startsWith(new Date().toISOString().slice(0, 7)))
              .reduce((sum, e) => sum + parseFloat(e[2].replace(/[^0-9.]/g, '')), 0);
          if (spentThisMonth > monthlyBudget * 0.8) {
              reply += `\n⚠️ Alert: 80% of ${currency} ${monthlyBudget.toFixed(2)} spent this month (${currency} ${spentThisMonth.toFixed(2)})!`;
          }
      }

      return reply;
  } catch (error) {
      console.error('[❌ ERROR] Failed to append to spreadsheet:', error.message);
      throw error;
  }
}
/**
 * Fetch expense data from the user's spreadsheet, filtered by job name.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @param {string} jobName - The job name to filter expenses.
 * @returns {Promise<Array>} An array of expense objects.
 */
async function fetchExpenseData(phoneNumber, jobName) {
  try {
    const { spreadsheetId, userEmail } = await getOrCreateUserSpreadsheet(phoneNumber);
    const auth = await getAuthorizedClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const RANGE = 'Sheet1!A:E'; // Columns: Date, Item, Amount, Store, Job
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: RANGE,
    });

    const rows = response.data.values;
    if (!rows || rows.length <= 1) {
      console.log('[DEBUG] No expense data found.');
      return [];
    }

    return rows.slice(1)
      .filter(row => row[4] === jobName)
      .map(row => ({
        date: row[0],
        item: row[1],
        amount: parseFloat(row[2].replace('$', '')) || 0,
        store: row[3],
        job: row[4],
      }));
  } catch (error) {
    console.error('[ERROR] Failed to fetch expense data:', error.message);
    throw error;
  }
}

// ─── ACTIVE JOB HANDLING (Using Firestore) ───────────────────────────────────
/**
 * Set the active job for a user in Firestore and log its start time in job history.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @param {string} jobName - The job to set as active.
 */
async function setActiveJob(phoneNumber, jobName) {
  try {
      const timestamp = new Date().toISOString();
      await db.collection('users').doc(phoneNumber).set({ 
          activeJob: jobName,
          jobHistory: admin.firestore.FieldValue.arrayUnion({ jobName, startTime: timestamp, status: 'active' })
      }, { merge: true });
      console.log(`[✅ SUCCESS] Active job set for ${phoneNumber}: ${jobName} at ${timestamp}`);
  } catch (error) {
      console.error('[❌ ERROR] Failed to set active job:', error.message);
      throw error;
  }
}

/**
 * Get the active job for a user from Firestore.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @returns {Promise<string|null>} The active job name, or null if not set.
 */
async function getActiveJob(phoneNumber) {
  try {
    const userDoc = await db.collection('users').doc(phoneNumber).get();
    return userDoc.exists ? userDoc.data().activeJob : null;
  } catch (error) {
    console.error('[❌ ERROR] Failed to retrieve active job:', error.message);
    throw error;
  }
}

// ─── EXPENSE ANALYTICS ─────────────────────────────────────────────────────────
/**
 * Calculate expense analytics (total spent, top store, etc.) from expense data.
 *
 * @param {Array} expenseData
 * @returns {Object|null} Analytics results or null if no data.
 */
function calculateExpenseAnalytics(expenseData) {
  if (!expenseData || expenseData.length === 0) {
    return null;
  }

  let totalSpent = 0;
  let storeCount = {};
  let itemCount = {};
  let biggestPurchase = { item: null, amount: 0 };

  for (const expense of expenseData) {
    totalSpent += expense.amount;
    storeCount[expense.store] = (storeCount[expense.store] || 0) + 1;
    itemCount[expense.item] = (itemCount[expense.item] || 0) + 1;
    if (expense.amount > biggestPurchase.amount) {
      biggestPurchase = { item: expense.item, amount: expense.amount };
    }
  }

  let topStore = Object.keys(storeCount).reduce((a, b) => (storeCount[a] > storeCount[b] ? a : b));
  let mostFrequentItem = Object.keys(itemCount).reduce((a, b) => (itemCount[a] > itemCount[b] ? a : b));

  return {
    totalSpent: `$${totalSpent.toFixed(2)}`,
    topStore,
    biggestPurchase: `${biggestPurchase.item} for $${biggestPurchase.amount.toFixed(2)}`,
    mostFrequentItem,
  };
}

// ─── RECEIPT PARSING & LOGGING ───────────────────────────────────────────────
/**
 * Parses raw OCR text from a receipt.
 *
 * @param {string} text - Raw OCR text.
 * @returns {Object|null} Parsed data containing date, item, amount, and store.
 */
function parseReceiptText(text) {
  try {
    console.log("[DEBUG] Raw OCR Text:", text);
    // Remove extra spaces and split into lines.
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    // 1. Store Name: take the first line that looks like a store name.
    let store = lines.find(line => /^[A-Za-z0-9\s&-]+$/.test(line) &&
      !/survey|contest|gift|rules|terms|conditions|receipt|transaction/i.test(line));
    if (!store) {
      store = lines[0] || "Unknown Store";
    }

    // 2. Date Extraction: look for common date formats.
    let dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4}|\d{2}\/\d{2}\/\d{2}|\d{4}-\d{2}-\d{2})/);
    let date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

    // 3. Amount Extraction: try to find a line containing "total" first.
    let amount;
    for (let i = 0; i < lines.length; i++) {
      if (/total/i.test(lines[i])) {
        const amtMatch = lines[i].match(/\$?(\d{1,6}\.\d{2})/);
        if (amtMatch) {
          amount = `$${amtMatch[1]}`;
          break;
        }
      }
    }
    if (!amount) {
      const amountMatches = text.match(/\$?(\d{1,6}\.\d{2})/gi);
      if (amountMatches) {
        amount = `$${amountMatches[amountMatches.length - 1].replace('$', '')}`;
      } else {
        amount = "Unknown Amount";
      }
    }

    // 4. Item Extraction: take a line that appears to be an item description.
    let item = lines.find(line => /\d+\s*(L|EA|KG|X|x|@|\$)/.test(line));
    if (!item) {
      item = lines.find(line => /[a-zA-Z]{3,}/.test(line) &&
        !/store|total|receipt|cash|change|approval|tax/i.test(line)) || "Miscellaneous Purchase";
    }

    console.log(`[DEBUG] Parsed - Store: ${store}, Date: ${date}, Item: ${item}, Amount: ${amount}`);
    return { date, item, amount, store };
  } catch (error) {
    console.error("[ERROR] Parsing failed:", error.message);
    return null;
  }
}

/**
 * Logs a receipt expense by parsing the OCR text and appending the data to the user's spreadsheet.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @param {string} extractedText - The OCR-extracted text from the receipt.
 */
async function logReceiptExpense(phoneNumber, extractedText) {
  console.log("[DEBUG] Logging receipt expense...");

  const parsedData = parseReceiptText(extractedText);
  if (!parsedData) {
    console.error("[ERROR] Failed to parse OCR data:", extractedText);
    return;
  }
  console.log(`[DEBUG] Parsed Data: ${JSON.stringify(parsedData)}`);

  // Check for missing required fields.
  let missingFields = [];
  if (!parsedData.date) missingFields.push("Date");
  if (!parsedData.amount || parsedData.amount === "Unknown Amount") missingFields.push("Amount");
  if (!parsedData.store || parsedData.store === "Unknown Store") missingFields.push("Store");

  if (missingFields.length > 0) {
    console.error(`[ERROR] Missing required fields: ${missingFields.join(", ")}`, parsedData);
    return;
  }

  // Get the active job from Firestore.
  const activeJob = await getActiveJob(phoneNumber) || "No Active Job";

  console.log("[DEBUG] Attempting to log to Google Sheets...");
  return appendToUserSpreadsheet(phoneNumber, [
    parsedData.date,
    parsedData.item || "Miscellaneous",
    parsedData.amount,
    parsedData.store,
    activeJob,
  ]);
}

/**
 * Calculates the income goal based on bills and expenses.
 *
 * @param {string} userId - The user's ID (WhatsApp number).
 * @returns {Promise<string|null>} The calculated income goal or null if an error occurs.
 */
async function calculateIncomeGoal(userId) {
  try {
     // Fetch recurring bills (e.g., rent, utilities)  
    const billsSnapshot = await db.collection('users').doc(userId).collection('bills').get();
      let totalFixedExpenses = 0;

      billsSnapshot.forEach(doc => {
          const bill = doc.data();
          totalFixedExpenses += parseFloat(bill.amount);
      });
      // Fetch variable expenses for the current month
      const currentDate = new Date();
      const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);

      const expensesSnapshot = await db.collection('users').doc(userId).collection('expenses')
          .where('date', '>=', firstDayOfMonth.toISOString())
          .get();

      let totalVariableExpenses = 0;
      expensesSnapshot.forEach(doc => {
          const expense = doc.data();
          totalVariableExpenses += parseFloat(expense.amount);
      });
      // Add a 10% savings target
      const savingsTarget = 0.1 * (totalFixedExpenses + totalVariableExpenses);
      const incomeGoal = totalFixedExpenses + totalVariableExpenses + savingsTarget;

      return incomeGoal.toFixed(2);
  } catch (error) {
      console.error(`[ERROR] Failed to calculate income goal for user ${userId}:`, error);
      return null;
  }
}
// ─── Quote Creation ───────────────────────────────────────────────
/**
 * Fetches material prices from a pricing spreadsheet.
 * @param {string} pricingSpreadsheetId - The ID of the pricing spreadsheet.
 * @returns {Promise<Object>} An object mapping item names to their prices.
 */
async function fetchMaterialPrices(pricingSpreadsheetId) {
  const auth = await getAuthorizedClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const range = 'Sheet1!A:B';

  try {
      const response = await sheets.spreadsheets.values.get({
          spreadsheetId: pricingSpreadsheetId,
          range,
      });
      const rows = response.data.values || [];
      if (!rows.length) {
          console.log('[DEBUG] No pricing data found in spreadsheet.');
          return {};
      }
      const priceMap = {};
      rows.slice(1).forEach(([itemName, price]) => {
          if (itemName) {
              const cleanedPrice = price ? parseFloat(price.replace(/[^0-9.]/g, '')) || 0 : 0;
              priceMap[itemName.toLowerCase()] = cleanedPrice;
          }
      });
      console.log('[✅] Fetched material prices:', priceMap);
      return priceMap;
  } catch (error) {
      console.error('[❌ ERROR] Failed to fetch material prices:', error.message);
      throw error;
  }
}
// ─── MODULE EXPORTS ───────────────────────────────────────────────────────────
module.exports = {
  getUserProfile,
  saveUserProfile, // ✅ Ensure this is included
  appendToUserSpreadsheet,
  fetchExpenseData,
  logReceiptExpense,
  getOrCreateUserSpreadsheet,
  setActiveJob,
  getActiveJob,
  createSpreadsheetForUser,
  calculateExpenseAnalytics,
  parseReceiptText,
  calculateIncomeGoal,
  logRevenueEntry,
  getAuthorizedClient,
  fetchMaterialPrices,
  ensureSheetExists
};

