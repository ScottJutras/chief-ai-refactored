const { google } = require('googleapis');
const { db, admin } = require('../services/firebase');
const { sendSpreadsheetEmail } = require("../utils/sendGridService");
const OpenAI = require('openai');

// Authentication setup
if (!process.env.GOOGLE_CREDENTIALS_BASE64) {
  throw new Error("[ERROR] GOOGLE_CREDENTIALS_BASE64 is missing. Cannot authenticate Google Sheets API.");
}
const googleCredentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
);

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive'
];

async function getAuthorizedClient() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: googleCredentials,
      scopes: SCOPES
    });
    return await auth.getClient();
  } catch (error) {
    console.error("[ERROR] Failed to get authorized client:", error.message);
    throw error;
  }
}

// User Profile Management
async function getUserProfile(phoneNumber) {
  try {
    const formattedNumber = phoneNumber.replace(/\D/g, "");
    const possibleFormats = [formattedNumber, `whatsapp:+${formattedNumber}`];

    let userProfile = null;
    for (const format of possibleFormats) {
      const userRef = db.collection("users").doc(format);
      const doc = await userRef.get();
      if (doc.exists) {
        userProfile = doc.data();
        console.log(`[✅] Retrieved user profile for ${format}:`, userProfile);
        return userProfile;
      }
    }

    console.log(`[ℹ️] No user profile found for ${phoneNumber}`);
    return null;
  } catch (error) {
    console.error("[❌] Error fetching user profile:", error);
    return null;
  }
}

async function saveUserProfile(userProfile) {
  try {
    const formattedNumber = userProfile.user_id.replace(/\D/g, "");
    console.log(`[DEBUG] Checking user profile for: ${formattedNumber}`);
    const userRef = db.collection("users").doc(formattedNumber);
    userProfile.onboarding_in_progress = false;
    if (!userProfile.subscription_tier) {
      userProfile.subscription_tier = "basic";
    }
    await userRef.set(userProfile, { merge: true });
    console.log(`[✅] User profile saved for ${formattedNumber} with subscription tier: ${userProfile.subscription_tier}`);
  } catch (error) {
    console.error("[❌] Failed to save user profile:", error);
    throw error;
  }
}

// Utility to format amount
function formatAmount(amount, type) {
  let amountStr = String(amount);
  let num = parseFloat(amountStr.replace(/[^0-9.-]+/g, '')) || 0;
  if (type === 'expense' || type === 'bill') {
    num = -Math.abs(num);
  } else {
    num = Math.abs(num);
  }
  return `$${num.toFixed(2)}`;
}

// Spreadsheet Creation and Retrieval
async function createSpreadsheetForUser(phoneNumber, userEmail = null) {
  try {
    console.log(`[DEBUG] Creating a new spreadsheet for user: ${phoneNumber}`);
    const auth = await getAuthorizedClient();
    const sheets = google.sheets({ version: "v4", auth });
    const drive = google.drive({ version: "v3", auth });

    const response = await sheets.spreadsheets.create({
      resource: {
        properties: { title: `Chief AI Financials - ${phoneNumber}` },
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
                    { userEnteredValue: { stringValue: "Type" } },
                    { userEnteredValue: { stringValue: "Category" } },
                    { userEnteredValue: { stringValue: "MediaUrl" } },
                    { userEnteredValue: { stringValue: "UserName" } }
                  ]
                }
              ]
            }
          },
          {
            properties: { title: "Revenue" },
            data: {
              rowData: [
                {
                  values: [
                    { userEnteredValue: { stringValue: "Date" } },
                    { userEnteredValue: { stringValue: "Description" } },
                    { userEnteredValue: { stringValue: "Amount" } },
                    { userEnteredValue: { stringValue: "Source" } },
                    { userEnteredValue: { stringValue: "Job" } },
                    { userEnteredValue: { stringValue: "Type" } },
                    { userEnteredValue: { stringValue: "Category" } },
                    { userEnteredValue: { stringValue: "MediaUrl" } },
                    { userEnteredValue: { stringValue: "UserName" } }
                  ]
                }
              ]
            }
          },
          {
            properties: { title: "Budget" },
            data: {
              rowData: [
                {
                  values: [
                    { userEnteredValue: { stringValue: "Date" } },
                    { userEnteredValue: { stringValue: "Item" } },
                    { userEnteredValue: { stringValue: "Amount" } },
                    { userEnteredValue: { stringValue: "Details" } }
                  ]
                }
              ]
            }
          },
          {
            properties: { title: "TaxExport" },
            data: {
              rowData: [
                {
                  values: [
                    { userEnteredValue: { stringValue: "Date" } },
                    { userEnteredValue: { stringValue: "Item" } },
                    { userEnteredValue: { stringValue: "Amount" } },
                    { userEnteredValue: { stringValue: "Category" } },
                    { userEnteredValue: { stringValue: "Logged By" } }
                  ]
                }
              ]
            }
          }
        ]
      },
      fields: "spreadsheetId"
    });

    const spreadsheetId = response.data.spreadsheetId;
    console.log(`[✅] Spreadsheet created: ${spreadsheetId}`);

    let emailToUse = userEmail;
    if (!emailToUse) {
      const userProfile = await getUserProfile(phoneNumber);
      emailToUse = userProfile?.email || process.env.FALLBACK_EMAIL;
    }

    if (!emailToUse) {
      console.error(`[ERROR] No email found for user ${phoneNumber}. Cannot share the spreadsheet.`);
      throw new Error(`No valid email found for user: ${phoneNumber}`);
    }

    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: {
        role: "writer",
        type: "anyone"
      }
    });

    await db.collection('users').doc(phoneNumber.replace(/\D/g, "")).update({ spreadsheetId });
    await sendSpreadsheetEmail(emailToUse, spreadsheetId);

    console.log(`[✅] Spreadsheet shared publicly: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
    return spreadsheetId;
  } catch (error) {
    console.error(`[❌] Failed to create and share spreadsheet:`, error.message);
    throw new Error(`Spreadsheet creation failed: ${error.message}`);
  }
}

async function getOrCreateUserSpreadsheet(phoneNumber) {
  try {
    const formattedNumber = phoneNumber.replace(/\D/g, "");
    const userDocRef = db.collection('users').doc(formattedNumber);
    const doc = await userDocRef.get();

    if (!doc.exists) {
      console.error(`[❌] No Firestore entry found for ${formattedNumber}`);
      throw new Error("User not found in Firestore.");
    }

    const userProfile = doc.data();
    if (!userProfile || !userProfile.email) {
      console.error(`[❌] No email found for ${formattedNumber}. Cannot create a spreadsheet.`);
      throw new Error("User email is required but missing.");
    }

    const userEmail = userProfile.email;
    let spreadsheetId = userProfile.spreadsheetId;

    if (!spreadsheetId) {
      console.log(`[DEBUG] No spreadsheet found for user (${formattedNumber}). Creating a new one.`);
      spreadsheetId = await createSpreadsheetForUser(formattedNumber, userEmail);
      await userDocRef.set({ spreadsheetId }, { merge: true });
      console.log(`[✅] Spreadsheet created and saved to Firebase for user (${formattedNumber}): ${spreadsheetId}`);
    }

    return { spreadsheetId, userEmail };
  } catch (error) {
    console.error(`[❌] Failed to retrieve or create spreadsheet for user (${phoneNumber}):`, error.message);
    throw error;
  }
}

// Spreadsheet Operations
async function appendToUserSpreadsheet(phoneNumber, rowData) {
  try {
    const { spreadsheetId, userEmail } = await getOrCreateUserSpreadsheet(phoneNumber);
    if (!spreadsheetId) throw new Error(`[ERROR] No spreadsheet ID for ${phoneNumber}`);

    const auth = await getAuthorizedClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const userProfile = await getUserProfile(phoneNumber);
    const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';

    const [date, item, amount, source, job, type, category, mediaUrl = '', userName = ''] = rowData;
    const amountNum = parseFloat(amount.replace(/[^0-9.]/g, ''));
    const formattedAmount = `${currency} ${amountNum.toFixed(2)}`;
    const range = type === 'revenue' ? 'Revenue!A:I' : 'Sheet1!A:I';
    const values = [[date, item, formattedAmount, source, job, type, category || "", mediaUrl, userName]];

    await ensureSheetExists(sheets, spreadsheetId, type === 'revenue' ? 'Revenue' : 'Sheet1');
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values }
    });
    console.log(`[✅] ${type} appended: ${JSON.stringify(values[0])}`);

    let reply = `✅ ${type} logged: ${formattedAmount} ${type === 'expense' ? `for ${item}` : type === 'revenue' ? `from ${source}` : `for ${item}`}`;

    if (type === 'bill') {
      await ensureSheetExists(sheets, spreadsheetId, 'Budget');
      const recurrenceMap = { 'yearly': 1, 'monthly': 12, 'weekly': 52, 'bi-weekly': 26, 'one-time': 0 };
      const annualCost = amountNum * (recurrenceMap[source] || 1);
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'Budget!A:D',
        valueInputOption: 'RAW',
        resource: { values: [[date, item, formattedAmount, `${source} - ${currency} ${annualCost.toFixed(2)}/yr`]] }
      });
      reply += `. Added to budget: ${currency} ${annualCost.toFixed(2)}/yr`;
      console.log(`[✅] Budget appended: ${item}, ${annualCost}/yr`);
    }

    userProfile.goalProgress = userProfile.goalProgress || { target: 10000, current: 0 };
    const profitImpact = type === 'revenue' ? amountNum : (type === 'expense' || type === 'bill') ? -amountNum : 0;
    userProfile.goalProgress.current += profitImpact;
    await saveUserProfile(userProfile);
    console.log(`[✅] Goal updated: ${userProfile.goalProgress.current}/${userProfile.goalProgress.target}`);

    if (type === 'expense' || type === 'bill') {
      const budgetRows = (await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Budget!A:D' })).data.values?.slice(1) || [];
      const monthlyBudget = budgetRows.reduce((sum, [, , amt]) => sum + parseFloat(amt.replace(/[^0-9.]/g, '')) / 12, 0);
      const expenses = (await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Sheet1!A:I' })).data.values?.slice(1) || [];
      const spentThisMonth = expenses
        .filter(e => (e[5] === 'expense' || e[5] === 'bill') && e[0].startsWith(new Date().toISOString().slice(0, 7)))
        .reduce((sum, e) => sum + parseFloat(e[2].replace(/[^0-9.]/g, '')), 0);
      if (spentThisMonth > monthlyBudget * 0.8) {
        reply += `\n⚠️ Alert: 80% of ${currency} ${monthlyBudget.toFixed(2)} spent this month (${currency} ${spentThisMonth.toFixed(2)})!`;
      }
    }

    return reply;
  } catch (error) {
    console.error('[❌] Failed to append to spreadsheet:', error.message);
    throw error;
  }
}

async function fetchExpenseData(phoneNumber, jobName) {
  try {
    const { spreadsheetId } = await getOrCreateUserSpreadsheet(phoneNumber);
    const auth = await getAuthorizedClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const range = 'Sheet1!A:I';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range
    });

    const rows = response.data.values || [];
    if (!rows || rows.length <= 1) {
      console.log('[DEBUG] No expense data found.');
      return [];
    }

    return rows.slice(1)
      .filter(row => row[4] === jobName && (row[5] === 'expense' || row[5] === 'bill'))
      .map(row => ({
        date: row[0],
        item: row[1],
        amount: parseFloat(row[2].replace(/[^0-9.]/g, '')) || 0,
        store: row[3],
        job: row[4]
      }));
  } catch (error) {
    console.error('[ERROR] Failed to fetch expense data:', error.message);
    throw error;
  }
}

// Job Management
async function setActiveJob(phoneNumber, jobName) {
  try {
    const timestamp = new Date().toISOString();
    await db.collection('users').doc(phoneNumber).set({ 
      activeJob: jobName,
      jobHistory: admin.firestore.FieldValue.arrayUnion({ jobName, startTime: timestamp, status: 'active' })
    }, { merge: true });
    console.log(`[✅] Active job set for ${phoneNumber}: ${jobName} at ${timestamp}`);
  } catch (error) {
    console.error('[❌] Failed to set active job:', error.message);
    throw error;
  }
}

async function getActiveJob(phoneNumber) {
  try {
    const userDoc = await db.collection('users').doc(phoneNumber).get();
    return userDoc.exists ? userDoc.data().activeJob : null;
  } catch (error) {
    console.error('[❌] Failed to retrieve active job:', error.message);
    throw error;
  }
}

async function finishJob(phoneNumber, jobName) {
  try {
    const timestamp = new Date().toISOString();
    const userRef = db.collection('users').doc(phoneNumber);
    const doc = await userRef.get();
    const jobHistory = doc.data().jobHistory || [];
    const updatedHistory = jobHistory.map(job =>
      job.jobName === jobName && job.status === 'active'
        ? { ...job, endTime: timestamp, status: 'finished' }
        : job
    );
    await userRef.set({ activeJob: null, jobHistory: updatedHistory }, { merge: true });
    console.log(`[✅] Job ${jobName} finished at ${timestamp}`);
  } catch (error) {
    console.error('[❌] Failed to finish job:', error.message);
    throw error;
  }
}

// Analytics and Parsing
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

  let topStore = Object.keys(storeCount).reduce((a, b) => (storeCount[a] > storeCount[b] ? a : b), null);
  let mostFrequentItem = Object.keys(itemCount).reduce((a, b) => (itemCount[a] > itemCount[b] ? a : b), null);

  return {
    totalSpent: `$${totalSpent.toFixed(2)}`,
    topStore,
    biggestPurchase: `${biggestPurchase.item} for $${biggestPurchase.amount.toFixed(2)}`,
    mostFrequentItem
  };
}

function parseReceiptText(text) {
  try {
    console.log("[DEBUG] Raw OCR Text:", text);
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    let store = lines.find(line => /^[A-Za-z0-9\s&-]+$/.test(line) &&
      !/survey|contest|gift|rules|terms|conditions|receipt|transaction/i.test(line)) || lines[0] || "Unknown Store";

    let dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4}|\d{2}\/\d{2}\/\d{2}|\d{4}-\d{2}-\d{2})/);
    let date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

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
      amount = amountMatches ? `$${amountMatches[amountMatches.length - 1].replace('$', '')}` : "Unknown Amount";
    }

    let item = lines.find(line => /\d+\s*(L|EA|KG|X|x|@|\$)/.test(line)) ||
      lines.find(line => /[a-zA-Z]{3,}/.test(line) && !/store|total|receipt|cash|change|approval|tax/i.test(line)) || "Miscellaneous Purchase";

    console.log(`[DEBUG] Parsed - Store: ${store}, Date: ${date}, Item: ${item}, Amount: ${amount}`);
    return { date, item, amount, store };
  } catch (error) {
    console.error("[ERROR] Parsing failed:", error.message);
    return null;
  }
}

async function logReceiptExpense(phoneNumber, extractedText) {
  console.log("[DEBUG] Logging receipt expense...");
  const parsedData = parseReceiptText(extractedText);
  if (!parsedData) {
    console.error("[ERROR] Failed to parse OCR data:", extractedText);
    return;
  }
  console.log(`[DEBUG] Parsed Data: ${JSON.stringify(parsedData)}`);

  let missingFields = [];
  if (!parsedData.date) missingFields.push("Date");
  if (!parsedData.amount || parsedData.amount === "Unknown Amount") missingFields.push("Amount");
  if (!parsedData.store || parsedData.store === "Unknown Store") missingFields.push("Store");

  if (missingFields.length > 0) {
    console.error(`[ERROR] Missing required fields: ${missingFields.join(", ")}`, parsedData);
    return;
  }

  const activeJob = await getActiveJob(phoneNumber) || "No Active Job";
  return appendToUserSpreadsheet(phoneNumber, [
    parsedData.date,
    parsedData.item || "Miscellaneous",
    parsedData.amount,
    parsedData.store,
    activeJob,
    'expense',
    'Miscellaneous',
    '',
    ''
  ]);
}

// Income Goal Calculation
async function calculateIncomeGoal(userId) {
  try {
    const billsSnapshot = await db.collection('users').doc(userId).collection('bills').get();
    let totalFixedExpenses = 0;
    billsSnapshot.forEach(doc => {
      const bill = doc.data();
      totalFixedExpenses += parseFloat(bill.amount);
    });

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

    const savingsTarget = 0.1 * (totalFixedExpenses + totalVariableExpenses);
    const incomeGoal = totalFixedExpenses + totalVariableExpenses + savingsTarget;
    return incomeGoal.toFixed(2);
  } catch (error) {
    console.error(`[ERROR] Failed to calculate income goal for user ${userId}:`, error);
    return null;
  }
}

// Revenue Logging
async function logRevenueEntry(ownerId, revenueData) {
  try {
    const { date, description, amount, source, job, category } = revenueData;
    const userProfile = await getUserProfile(ownerId);
    const spreadsheetId = userProfile.spreadsheetId;
    const auth = await getAuthorizedClient();
    const sheets = google.sheets({ version: 'v4', auth });

    await ensureSheetExists(sheets, spreadsheetId, 'Revenue');
    const formattedAmount = formatAmount(amount, 'revenue');
    const values = [[date, description, formattedAmount, source, job, 'revenue', category, '', userProfile.name || 'Unknown User']];
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Revenue!A:I',
      valueInputOption: 'USER_ENTERED',
      resource: { values }
    });

    console.log(`[✅] Revenue logged: ${formattedAmount} from ${source} on ${date}`);
    return `✅ Revenue logged: ${formattedAmount} from ${source}`;
  } catch (error) {
    console.error("[❌] Error logging revenue entry:", error.message);
    throw error;
  }
}

// Deduction Suggestion
async function suggestDeductions(userId, { description, category }) {
  try {
    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `Suggest a tax deduction for an expense with description "${description}" and category "${category}". Return a string like "Deduction: [category] ([description])".`;
    const gptResponse = await openaiClient.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: description }
      ],
      max_tokens: 50,
      temperature: 0.3
    });
    return gptResponse.choices[0].message.content;
  } catch (error) {
    console.error(`[ERROR] Failed to suggest deductions for ${description}:`, error.message);
    return `Deduction: ${category} (${description})`;
  }
}

// Utility to ensure sheet exists
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
    throw error;
  }
}

// Quote Creation
async function fetchMaterialPrices(pricingSpreadsheetId) {
  const auth = await getAuthorizedClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const range = 'Sheet1!A:B';

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: pricingSpreadsheetId,
      range
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
    console.error('[❌] Failed to fetch material prices:', error.message);
    throw error;
  }
}

module.exports = {
  getUserProfile,
  saveUserProfile,
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
  ensureSheetExists,
  suggestDeductions
};