require('dotenv').config();

// Core Node.js utilities
const { URLSearchParams } = require('url');
const fs = require('fs');
const path = require('path');
const { db, storage } = require('./firebase');

// Third-party libraries
const admin = require("firebase-admin");
const express = require('express');
const OpenAI = require('openai');
const axios = require('axios');
const { google } = require('googleapis');
const PDFKit = require('pdfkit');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const Papa = require('papaparse');
const XLSX = require('xlsx');
const fuzzball = require('fuzzball');

// Local utilities
const { handleInputWithAI, detectErrors, correctErrorsWithAI } = require('./utils/aiErrorHandler');
const areaCodeMap = require('./utils/areaCodes');
const { parseExpenseMessage, parseRevenueMessage } = require('./utils/expenseParser');
const { processDocumentAI } = require('./documentAI');
const { transcribeAudio } = require('./utils/transcriptionService');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('./utils/stateManager');
const { sendTemplateMessage } = require('./utils/twilioHelper');
const { updateUserTokenUsage, checkTokenLimit, getSubscriptionTier } = require('./utils/tokenManager');
const {
    getUserProfile,
    saveUserProfile,
    logRevenueEntry,
    appendToUserSpreadsheet,
    getOrCreateUserSpreadsheet,
    fetchExpenseData,
    calculateExpenseAnalytics,
    setActiveJob,
    getActiveJob,
    createSpreadsheetForUser,
    calculateIncomeGoal,
    fetchMaterialPrices,
} = require("./utils/googleSheets");
const { detectCountryAndRegion } = require('./utils/location');
const { extractTextFromImage } = require('./utils/visionService');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { sendSpreadsheetEmail, sendEmail } = require('./utils/sendGridService');
const { generateQuotePDF } = require('./utils/pdfService');
const { parseQuoteMessage, buildQuoteDetails } = require('./utils/quoteUtils');
const { getAuthorizedClient } = require("./utils/googleSheets");
const { getTaxRate } = require('./utils/taxRate.js');
const { getValidationLists } = require('./utils/validateLocation'); // Adjust path as needed
const { isValidExpenseInput, isOnboardingTrigger, isValidCommand } = require('./utils/inputValidator');

// Google credentials
const googleCredentials = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
console.log('[DEBUG] Service account email from GOOGLE_CREDENTIALS_BASE64:', googleCredentials.client_email);

// Helper functions for state persistence in Firestore
const getOnboardingState = async (from) => {
    const stateDoc = await db.collection('onboardingStates').doc(from).get();
    return stateDoc.exists ? stateDoc.data() : null;
};

const setOnboardingState = async (from, state) => {
    await db.collection('onboardingStates').doc(from).set(state);
};

const deleteOnboardingState = async (from) => {
    await db.collection('onboardingStates').doc(from).delete();
};

const setLastQuery = async (from, queryData) => {
    await db.collection('lastQueries').doc(from).set(queryData, { merge: true });
};

const getLastQuery = async (from) => {
    const doc = await db.collection('lastQueries').doc(from).get();
    return doc.exists ? doc.data() : null;
};

const finishJob = async (phoneNumber, jobName) => {
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
};
async function updateBillInSheets(userId, billData) {
    try {
        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = (await getUserProfile(userId)).spreadsheetId;
        const range = 'Sheet1!A:I';
        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
        const rows = response.data.values || [];
        const header = rows[0];
        const dataRows = rows.slice(1);

        // Find the bill by name and type 'bill'
        const billRowIndex = dataRows.findIndex(row => 
            row[1]?.toLowerCase() === billData.billName.toLowerCase() && row[5] === 'bill'
        );
        
        if (billRowIndex === -1) {
            console.log(`[⚠️] Bill "${billData.billName}" not found in Sheets.`);
            return false;
        }

        const rowIndex = billRowIndex + 2; // +1 for header, +1 for 1-based index
        const existingRow = dataRows[billRowIndex];
        const updatedRow = [
            billData.date || existingRow[0],           // Date
            billData.billName,                         // Name
            billData.amount || existingRow[2],         // Amount
            billData.recurrence || existingRow[3],     // Recurrence (stored in store/source column)
            existingRow[4],                            // Job
            'bill',                                    // Type
            existingRow[6],                            // Category
            existingRow[7] || '',                      // Media URL
            existingRow[8] || 'Unknown'                // Logged By
        ];

        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `Sheet1!A${rowIndex}:I${rowIndex}`,
            valueInputOption: 'RAW',
            resource: { values: [updatedRow] }
        });
        console.log(`[✅] Bill "${billData.billName}" updated in Sheets at row ${rowIndex}.`);
        return true;
    } catch (error) {
        console.error(`[ERROR] Failed to update bill "${billData.billName}" in Sheets:`, error);
        return false;
    }
}

async function deleteBillInSheets(userId, billName) {
    try {
        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = (await getUserProfile(userId)).spreadsheetId;
        const range = 'Sheet1!A:I';
        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
        const rows = response.data.values || [];
        const dataRows = rows.slice(1);

        // Find the bill by name and type 'bill'
        const billRowIndex = dataRows.findIndex(row => 
            row[1]?.toLowerCase() === billName.toLowerCase() && row[5] === 'bill'
        );
        
        if (billRowIndex === -1) {
            console.log(`[⚠️] Bill "${billName}" not found in Sheets.`);
            return false;
        }

        const rowIndex = billRowIndex + 2; // +1 for header, +1 for 1-based index
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `Sheet1!A${rowIndex}:I${rowIndex}`,
            valueInputOption: 'RAW',
            resource: { values: [[]] } // Clear the row
        });
        console.log(`[✅] Bill "${billName}" deleted from Sheets at row ${rowIndex}.`);
        return true;
    } catch (error) {
        console.error(`[ERROR] Failed to delete bill "${billName}" in Sheets:`, error);
        return false;
    }
}

// Team Management Functions
const getTeamInfo = async (phoneNumber) => {
    const userRef = db.collection('users').doc(phoneNumber);
    const doc = await userRef.get();
    return doc.exists ? { ownerId: phoneNumber, teamMembers: doc.data().teamMembers || [] } : null;
};

const getOwnerFromTeamMember = async (phoneNumber) => {
    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('teamMembers', 'array-contains', { phone: phoneNumber }).get();
    if (!snapshot.empty) {
        const ownerDoc = snapshot.docs[0];
        return { ownerId: ownerDoc.id, teamMembers: ownerDoc.data().teamMembers || [] };
    }
    return null;
};

const addTeamMember = async (ownerPhone, memberName, memberPhone) => {
    const userRef = db.collection('users').doc(ownerPhone);
    const doc = await userRef.get();
    const teamMembers = doc.data().teamMembers || [];
    if (!teamMembers.some(member => member.phone === memberPhone)) {
        teamMembers.push({ name: memberName, phone: memberPhone, role: 'member' });
        await userRef.update({ teamMembers });
        console.log(`[✅] Added ${memberName} (${memberPhone}) to ${ownerPhone}'s team`);
    }
};

const removeTeamMember = async (ownerPhone, memberPhone) => {
    const userRef = db.collection('users').doc(ownerPhone);
    const doc = await userRef.get();
    const teamMembers = doc.data().teamMembers || [];
    const updatedTeamMembers = teamMembers.filter(member => member.phone !== memberPhone);
    await userRef.update({ teamMembers: updatedTeamMembers });
    console.log(`[✅] Removed ${memberPhone} from ${ownerPhone}'s team`);
};

// Utility Functions
function normalizePhoneNumber(phone) {
    return phone
        .replace(/^whatsapp:/i, '')
        .replace(/^\+/, '')
        .trim();
}

// Express App Setup
const app = express();
app.use(express.json({ limit: '50mb' })); // For Deep Dive file uploads
app.use(express.urlencoded({ extended: true }));

const onboardingSteps = [
    "Can I get your name?",
];

const teamMemberOnboardingSteps = [
    "Can I get your name?"
];

const onboardingTemplates = {
    1: "HX4cf7529ecaf5a488fdfa96b931025023",
    4: "HX066a88aad4089ba4336a21116e923557",
    5: "HX1d4c5b90e5f5d7417283f3ee522436f4",
    6: "HX5c80469d7ba195623a4a3654a27c19d7",
    7: "HXd1fcd47418eaeac8a94c57b930f86674",
    8: "HX3e231458c97ba2ca1c5588b54e87c081",
    9: "HX20b1be5490ea39f3730fb9e70d5275df",
    10: "HX99fd5cad1d49ab68e9afc6a70fe4d24a",
    12: "HXf6e1f67ace192ccd21d6e187ea7d6c34"
};

const confirmationTemplates = {
    revenue: "HXb3086ca639cb4882fb2c68f2cd569cb4",
    expense: "HX9f6b7188f055fa25f8170f915e53cbd0",
    bill: "HX6de403c09a8ec90183fbb3fe05413252",
    startJob: "HXa4f19d568b70b3493e64933ce5e6a040",
    locationConfirmation: "HX0280df498999848aaff04cc079e16c31",
    spreadsheetLink: "HXf5964d5ffeecc5e7f4e94d7b3379e084",
    deleteConfirmation: "HXabcdef1234567890abcdef123456789", // Placeholder; replace with actual template ID
    teamMemberInvite: "HX1234567890abcdef1234567890abcdef", // Placeholder; replace with actual template ID
    businessLocationConfirmation: "HXa885f78d7654642672bfccfae98d57cb"
};
// Default tax preparation categories (aligned with Schedule C for simplicity)
const defaultExpenseCategories = {
    "Advertising": ["marketing", "ads", "promotion"],
    "Car and Truck Expenses": ["fuel", "mileage", "vehicle", "gas"],
    "Contract Labor": ["labor", "subcontractor", "worker"],
    "Cost of Goods Sold": ["materials", "supplies", "inventory"],
    "Insurance": ["insurance", "premium"],
    "Office Expenses": ["stationery", "paper", "office supplies"],
    "Rent or Lease": ["rent", "lease", "rental"],
    "Repairs and Maintenance": ["repair", "maintenance", "fix"],
    "Supplies": ["tools", "equipment", "nails", "paint"],
    "Taxes and Licenses": ["tax", "license", "permit"],
    "Travel": ["travel", "hotel", "flight"],
    "Meals": ["meal", "food", "dining"],
    "Utilities": ["electricity", "water", "internet", "phone"],
    "Other Expenses": ["misc", "miscellaneous", "general"]
};

const defaultRevenueCategories = {
    "Revenue - Services": ["service", "labor", "work"],
    "Revenue - Sales": ["sale", "product", "goods"],
    "Revenue - Other": ["misc", "other", "miscellaneous"]
};


// Function to determine category using AI
const categorizeEntry = async (type, data, userProfile) => {
    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const inputText = type === 'expense'
        ? `${data.item} from ${data.store}`
        : `${data.description} from ${data.source || data.client}`;
    const industry = userProfile.industry || "Other";
    const prompt = `
        Categorize this ${type} for tax preparation based on a CFO's perspective:
        - Input: "${inputText}"
        - Industry: "${industry}"
        - Available ${type} categories: ${JSON.stringify(type === 'expense' ? defaultExpenseCategories : defaultRevenueCategories, null, 2)}
        Return JSON: { category: "string" }
    `;

    const gptResponse = await openaiClient.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
            { role: "system", content: prompt },
            { role: "user", content: inputText }
        ],
        max_tokens: 50,
        temperature: 0.3
    });

    const result = JSON.parse(gptResponse.choices[0].message.content);
    return result.category || (type === 'expense' ? "Other Expenses" : "Revenue - Other");
};

// Deep Dive File Parsing
const parseFinancialFile = (fileBuffer, fileType) => {
    let data = [];
    if (fileType === 'text/csv') {
        const csvText = fileBuffer.toString('utf-8');
        const result = Papa.parse(csvText, { header: true, skipEmptyLines: true });
        data = result.data;
    } else if (fileType === 'application/vnd.ms-excel' || fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    }
    return data.map(row => ({
        date: row.Date || row.date || new Date().toISOString().split('T')[0],
        amount: parseFloat(row.Amount || row.amount || 0).toFixed(2),
        description: row.Description || row.description || row.Item || row.item || "Unknown",
        source: row.Source || row.source || row.Store || row.store || "Unknown",
        type: row.Type || row.type || (parseFloat(row.Amount || row.amount) >= 0 ? 'revenue' : 'expense')
    }));
};

// Deep Dive Report Generation
const generateDeepDiveReport = async (userId, data, tier) => {
    const userProfile = await getUserProfile(userId);
    const doc = new PDFKit();
    const outputPath = `/tmp/deep_dive_${userId}_${Date.now()}.pdf`;
    const chartCanvas = new ChartJSNodeCanvas({ width: 600, height: 400 });

    const expenses = data.filter(row => row.type === 'expense');
    const revenues = data.filter(row => row.type === 'revenue');
    const totalExpenses = expenses.reduce((sum, row) => sum + parseFloat(row.amount), 0);
    const totalRevenue = revenues.reduce((sum, r) => sum + parseFloat(r.amount), 0);
    const profit = totalRevenue - totalExpenses;

    doc.fontSize(16).text(`Deep Dive Financial Analysis - ${tier.name}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Generated for: ${userProfile.name || 'User'} on ${new Date().toLocaleDateString()}`);
    doc.moveDown();

    doc.text("Profit & Loss Statement");
    doc.text(`Total Revenue: $${totalRevenue.toFixed(2)}`);
    doc.text(`Total Expenses: $${totalExpenses.toFixed(2)}`);
    doc.text(`Net Profit: $${profit.toFixed(2)}`);
    doc.moveDown();

    const chartBuffer = await chartCanvas.renderToBuffer({
        type: 'bar',
        data: {
            labels: ['Revenue', 'Expenses'],
            datasets: [{ label: 'Amount ($)', data: [totalRevenue, totalExpenses], backgroundColor: ['#36A2EB', '#FF6384'] }]
        }
    });
    doc.image(chartBuffer, { width: 300 });

    if (tier.features.includes('forecast_1yr') || tier.features.includes('forecast_10yr')) {
        const forecastYears = tier.features.includes('forecast_10yr') ? 10 : 1;
        const monthlyRevenue = totalRevenue / (data.length / 30);
        const monthlyExpenses = totalExpenses / (data.length / 30);
        const forecast = [];
        for (let i = 1; i <= forecastYears * 12; i++) {
            forecast.push({
                month: new Date().setMonth(new Date().getMonth() + i),
                revenue: monthlyRevenue * (1 + 0.02 * i),
                expenses: monthlyExpenses * (1 + 0.01 * i)
            });
        }
        doc.addPage().text(`Cash Flow Forecast (${forecastYears} Year${forecastYears > 1 ? 's' : ''})`);
        forecast.slice(0, 12).forEach(f => {
            doc.text(`${new Date(f.month).toLocaleDateString()}: Revenue $${f.revenue.toFixed(2)}, Expenses $${f.expenses.toFixed(2)}, Net $${(f.revenue - f.expenses).toFixed(2)}`);
        });
    }

    if (tier.features.includes('goals')) {
        doc.addPage().text("10-Year Financial Goals");
        doc.text("- Year 1: Establish stable cash flow ($5000/month net)");
        doc.text("- Year 5: Double revenue through new product lines");
        doc.text("- Year 10: Achieve $1M in annual profit");
    }

    doc.pipe(fs.createWriteStream(outputPath));
    doc.end();

    const auth = await getAuthorizedClient();
    const drive = google.drive({ version: 'v3', auth });
    const fileMetadata = { name: `Deep_Dive_${userId}_${Date.now()}.pdf` };
    const media = { mimeType: 'application/pdf', body: fs.createReadStream(outputPath) };
    const driveResponse = await drive.files.create({
        resource: fileMetadata,
        media,
        fields: 'id, webViewLink'
    });
    await drive.permissions.create({
        fileId: driveResponse.data.id,
        requestBody: { role: 'reader', type: 'anyone' }
    });

    return driveResponse.data.webViewLink;
};

// Retry logic for getUserProfile to handle Firestore eventual consistency
async function getUserProfileWithRetry(from, retries = 3, delay = 100) {
    for (let i = 0; i < retries; i++) {
        const profile = await getUserProfile(from);
        if (profile) return profile;
        console.log(`[RETRY] Attempt ${i + 1} to fetch profile for ${from}`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    return null;
}

// Retry logic for acquiring lock with stale lock cleanup
async function acquireLock(lockKey, from, retries = 5, delay = 750, ttlSeconds = 5) {
    for (let i = 0; i < retries; i++) {
        const lockDoc = await db.collection('locks').doc(lockKey).get();
        if (!lockDoc.exists) {
            console.log(`[LOCK] Acquired lock for ${from}`);
            await db.collection('locks').doc(lockKey).set({ 
                locked: true, 
                timestamp: new Date().toISOString(),
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return true;
        }

        // Check if lock is stale (older than ttlSeconds)
        const lockData = lockDoc.data();
        const lockTimestamp = new Date(lockData.timestamp);
        const ageSeconds = (Date.now() - lockTimestamp.getTime()) / 1000;
        if (ageSeconds > ttlSeconds) {
            console.log(`[LOCK] Deleting stale lock for ${from} (age: ${ageSeconds.toFixed(2)}s)`);
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Acquired lock for ${from} after deleting stale lock`);
            await db.collection('locks').doc(lockKey).set({ 
                locked: true, 
                timestamp: new Date().toISOString(),
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return true;
        }

        console.log(`[LOCK] Retry ${i + 1} for ${from}: lock still held (age: ${ageSeconds.toFixed(2)}s)`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    console.log(`[LOCK] Failed to acquire lock for ${from} after ${retries} retries`);
    return false;
}

app.post('/webhook', async (req, res) => {
  console.log(`[DEBUG] POST /webhook invoked at ${new Date().toISOString()}`);
    // Extract Twilio-specific fields safely
    const rawPhone = req.body.From || 'UNKNOWN_FROM';
    const from = normalizePhoneNumber(rawPhone);
    const body = req.body.Body?.trim() || '[No body]';
    const mediaUrl = req.body.MediaUrl0 || null;
    const mediaType = req.body.MediaContentType0 || null;

    console.log(`[DEBUG] POST /webhook received: From=${from || 'unknown'}, Body=${body || 'none'}, Media=${mediaUrl || 'none'}, MediaType=${mediaType || 'none'}, Headers=${JSON.stringify(req.headers)}`);


    // Lock mechanism with retry and stale lock cleanup
        const lockKey = `lock:${from}`;
        const lockAcquired = await acquireLock(lockKey, from);
        if (!lockAcquired) {
            console.log(`[INFO] Request for ${from} is locked after retries, ignoring`);
            return res.send(`<Response><Message>I'm busy processing your previous request. Please try again in a moment!</Message></Response>`);
        }

    try {   // 1) Fetch profile & team info
        let userProfile = await getUserProfileWithRetry(from);
        const ownerInfo = await getOwnerFromTeamMember(from);
        let ownerId = userProfile?.ownerId || from;
        const isOwner = !ownerInfo || ownerId === from;
        const ownerProfile = isOwner ? userProfile : await getUserProfileWithRetry(ownerId);
        const userName = userProfile?.name || 'Unknown User';

        console.log(`[✅] Retrieved user profile for ${from}: ${JSON.stringify(userProfile)}`);
        
        //2) Handle new users or team members
        let userProfileData;
        if (!userProfile && !ownerInfo) {
            const countryCode = from.slice(0, 2);
            const areaCode = from.slice(2, 5);
            const areaCodeMap = { '416': { country: 'Canada', province: 'Ontario' } };
            const location = countryCode === '+1' && areaCodeMap[areaCode] ? areaCodeMap[areaCode] : { country: 'Canada', province: 'Ontario' };
            await db.runTransaction(async (transaction) => {
                const userRef = db.collection('users').doc(from);
                transaction.set(userRef, {
                    user_id: from,
                    created_at: new Date().toISOString(),
                    onboarding_in_progress: true,
                    teamMembers: [],
                    country: location.country,
                    province: location.province
                }, { merge: true });
            });
            console.log(`[✅] Initial user profile created for ${from} with auto-detected ${location.country}/${location.province}`);
            
            userProfile = await getUserProfileWithRetry(from);
            if (!userProfile) {
    console.error(`[ERROR] Failed to fetch profile for ${from} after creation`);
    await db.collection('locks').doc(lockKey).delete();
    return res.status(500).send("Internal Server Error: Failed to fetch user profile");
  }
            ownerId = from;
            userProfileData = userProfile;
            
        } else if (ownerInfo && !userProfile) {
            await db.runTransaction(async (transaction) => {
                const userRef = db.collection('users').doc(from);
                transaction.set(userRef, {
                    user_id: from,
                    created_at: new Date().toISOString(),
                    onboarding_in_progress: true,
                    isTeamMember: true,
                    ownerId: ownerInfo.ownerId
                }, { merge: true });
            });
            userProfileData = await getUserProfileWithRetry(from);
            if (!userProfileData) {
                console.error(`[ERROR] Failed to fetch user profile for team member ${from} after creation`);
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (team member profile fetch failure)`);
                return res.status(500).send("Internal Server Error: Failed to fetch user profile");
            }
            userProfileData = userProfile;

        } else {
      // existing user
      userProfileData = userProfile;
    }

    // 3) Now we truly have a non-null profile:
console.log(`[✅] Working with profile for ${from}: ${JSON.stringify(userProfileData)}`);
const contractorName = userProfileData.name || 'Your Company Name';           
        
            
     // 4) Completed‐onboarding guard
    if (userProfileData.onboarding_completed) {
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (already onboarded)`);
      return handleNormalCommands(from, body, userProfileData);
    }

    // Update token usage
        await updateUserTokenUsage(ownerId, { 
            messages: 1, 
            aiCalls: (body && (body.includes('$') || body.toLowerCase().includes("received") || body.toLowerCase().startsWith("quote"))) || mediaUrl ? 1 : 0 
        });
        const subscriptionTier = await getSubscriptionTier(ownerId);
        const withinLimit = await checkTokenLimit(ownerId, subscriptionTier);
        if (withinLimit.exceeded) {
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (trial limit exceeded)`);
            return res.send(`<Response><Message>⚠️ Trial limit reached! Reply 'Upgrade' to continue.</Message></Response>`);
        }

        // Media handling and initial input processing
        let input = body;
        let type = 'expense';

        if (mediaUrl && mediaType) {
            const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
            const mediaContent = Buffer.from(response.data);

            if (mediaType.startsWith('image/')) {
                input = await processDocumentAI(mediaContent);
                type = 'expense';
            } else if (mediaType.startsWith('audio/')) {
                input = await transcribeAudio(mediaContent);
                type = input?.toLowerCase().includes('revenue') || input?.toLowerCase().includes('earned') ? 'revenue' : 'expense';
            }

            if (!input) {
                reply = "⚠️ Failed to process media. Please try again.";
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (media processing failure)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }
        } else if (!body) {
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (missing body)`);
            return res.status(400).send("Bad Request: Missing 'Body' or media");
        } else {
            type = body.toLowerCase().includes('revenue') || body.toLowerCase().includes('earned') ? 'revenue' : 'expense';
        }
            // Handle onboarding for users in progress
        if (userProfileData.onboarding_in_progress || (!userProfileData.onboarding_completed && body?.trim().toLowerCase() === 'start onboarding')) {
            let state = await getOnboardingState(from);
            const responseMsg = body?.trim();

            if (!state || (!userProfileData.onboarding_in_progress && responseMsg.toLowerCase() === 'start onboarding')) {
                if (userProfileData.onboarding_completed) {
                    reply = "You've already completed onboarding.";
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (onboarding already completed)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                state = {
                    step: 0,
                    responses: {},
                    detectedLocation: {
                        country: userProfileData.country || "Canada",
                        province: userProfileData.province || "Ontario"
                    }
                };
                await setOnboardingState(from, state);
                await db.runTransaction(async (transaction) => {
                    const userRef = db.collection('users').doc(from);
                    transaction.update(userRef, { onboarding_in_progress: true });
                });
                reply = "Welcome and thank you for the add! I’m Chief, your personal CFO. You’re about to take your business to the next level.\n" +
                        "With my help, you’ll grow your profits, cut unnecessary spending, and take control with surgical precision.\n" +
                        "Let’s get started — just reply with your full name so I can set up your account.";
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (initial onboarding)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }
            if (userProfileData.onboarding_completed) {
            // user is fully onboarded—skip all of the onboarding logic
            return handleNormalCommands(from, responseMsg, userProfileData);
            }
            console.log(`[DEBUG] Onboarding state for ${from}: step=${state.step}, response=${responseMsg}`);

            if (state.step === 0) {
                if (!responseMsg) {
                    reply = "Please provide your full name to continue onboarding.";
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (step 0 empty)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                state.responses.name = responseMsg;
                userProfileData.name = responseMsg;
                state.step = 1;
                await setOnboardingState(from, state);
                await db.runTransaction(async (transaction) => {
                    const userRef = db.collection('users').doc(from);
                    transaction.update(userRef, { name: responseMsg });
                });
                await sendTemplateMessage(
                    from,
                    "HX0280df498999848aaff04cc079e16c31",
                    [
                        { type: "text", text: userProfileData.province || "Ontario" },
                        { type: "text", text: userProfileData.country || "Canada" }
                    ]
                );
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (step 0 complete)`);
                return res.send(`<Response></Response>`);
            } else if (state.step === 1) {
                const lcResponse = responseMsg.toLowerCase();
                if (lcResponse === "yes") {
                    state.step = 2;
                    state.responses.location = {
                        province: userProfileData.province,
                        country: userProfileData.country
                    };
                    await setOnboardingState(from, state);
                    await sendTemplateMessage(
                        from,
                        "HXa885f78d7654642672bfccfae98d57cb",
                        []
                    );
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (step 1 yes)`);
                    return res.send(`<Response></Response>`);
                } else if (lcResponse === "edit") {
                    state.step = 1.5;
                    await setOnboardingState(from, state);
                    reply = "Please provide your State/Province, Country (e.g., 'Ontario, Canada' or 'Ontario Canada').";
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (step 1 edit)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                } else if (lcResponse === "cancel") {
                    await deleteOnboardingState(from);
                    await db.collection('onboarding').doc(from).delete();
                    await db.runTransaction(async (transaction) => {
                        const userRef = db.collection('users').doc(from);
                        transaction.update(userRef, {
                            onboarding_in_progress: false,
                            name: admin.firestore.FieldValue.delete(),
                            country: admin.firestore.FieldValue.delete(),
                            province: admin.firestore.FieldValue.delete(),
                            email: admin.firestore.FieldValue.delete(),
                            business_province: admin.firestore.FieldValue.delete(),
                            business_country: admin.firestore.FieldValue.delete(),
                            spreadsheetId: admin.firestore.FieldValue.delete()
                        });
                    });
                       reply = "Onboarding cancelled. Reply 'Start Onboarding' to begin again.";
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (step 1 cancel)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                } else {
                    reply = "Please reply with 'Yes', 'Edit', or 'Cancel' to confirm your location.";
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (step 1 invalid)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                } else if (state.step === 1.5) {
    // ensure we have something to parse
    if (!responseMsg) {
        reply = "Please provide your State/Province, Country (e.g., 'Ontario, Canada' or 'Ontario Canada').";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (step 1.5 invalid format)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // prepare validation lists and aliases
    const { knownProvinces, knownCountries } = getValidationLists();
    const countryAliases = {
        'united states': 'USA',
        'us': 'USA',
        'canada': 'Canada'
    };

    // attempt to split on comma or whitespace
    let manualProvince, manualCountry;
    const match = responseMsg.match(/^(.+?)[\s,]+(.+)$/);
    if (match) {
        manualProvince = match[1].trim();
        manualCountry  = match[2].trim();
    } else {
        const parts = responseMsg.trim().split(/\s+/);
        manualCountry  = parts.pop();
        manualProvince = parts.join(' ').trim();
    }

    // normalize common country names
    manualCountry = countryAliases[manualCountry.toLowerCase()] || manualCountry;

    // check against our lists
    let isValidProvince = knownProvinces.some(p => p.toLowerCase() === manualProvince.toLowerCase());
    let isValidCountry  = knownCountries.some(c => c.toLowerCase() === manualCountry.toLowerCase());

    // fuzzy-match or AI-fallback if needed
    if (!isValidProvince || !isValidCountry) {
        // fuzzy province
        if (!isValidProvince) {
            const best = knownProvinces.reduce((best, p) => {
                const score = fuzzball.ratio(p.toLowerCase(), manualProvince.toLowerCase());
                return score > best.score ? { val: p, score } : best;
            }, { val: null, score: 0 });
            if (best.score > 80) {
                console.log(`[FUZZY MATCH] Corrected province "${manualProvince}" → "${best.val}"`);
                manualProvince = best.val;
                isValidProvince = true;
            }
        }
        // fuzzy country
        if (!isValidCountry) {
            const best = knownCountries.reduce((best, c) => {
                const score = fuzzball.ratio(c.toLowerCase(), manualCountry.toLowerCase());
                return score > best.score ? { val: c, score } : best;
            }, { val: null, score: 0 });
            if (best.score > 80) {
                console.log(`[FUZZY MATCH] Corrected country "${manualCountry}" → "${best.val}"`);
                manualCountry = best.val;
                isValidCountry = true;
            }
        }

        // AI fallback if still invalid
        if (!isValidProvince || !isValidCountry) {
            state.invalidLocationAttempts = (state.invalidLocationAttempts || 0) + 1;
            if (state.invalidLocationAttempts > 3) {
                reply = "Too many invalid attempts. Please contact support or try again later.";
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (step 1.5 too many attempts)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }
            try {
                const aiRes = await openai.createChatCompletion({
                    model: 'gpt-3.5-turbo',
                    messages: [
                        {
                            role: 'system',
                            content: `Parse this location string: "${responseMsg}". Return JSON: { province: "string", country: "string" }.`
                        },
                        { role: 'user', content: responseMsg }
                    ],
                    max_tokens: 50,
                    temperature: 0.3
                });
                const aiResult = JSON.parse(aiRes.data.choices[0].message.content);
                manualProvince = aiResult.province;
                manualCountry  = aiResult.country;
                if (
                    !knownProvinces.some(p => p.toLowerCase() === manualProvince.toLowerCase()) ||
                    !knownCountries.some(c => c.toLowerCase() === manualCountry.toLowerCase())
                ) {
                    throw new Error("AI returned invalid province or country");
                }
                console.log(`[AI MATCH] Parsed "${responseMsg}" → ${manualProvince}, ${manualCountry}`);
            } catch (err) {
                console.error(`[ERROR] AI parsing failed for ${from}: ${err.message}`);
                reply = "Unable to parse location. Please use 'State/Province, Country' format.";
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (step 1.5 AI parse failure)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }
        }
    }

    // all good: save and advance
    state.responses.location = { province: manualProvince, country: manualCountry };
    state.step = 2;
    await setOnboardingState(from, state);
    await db.runTransaction(transaction => {
        const userRef = db.collection('users').doc(from);
        transaction.update(userRef, {
            province: manualProvince,
            country: manualCountry
        });
    });
    // send next template and release lock
                await sendTemplateMessage(
                    from,
                    "HXa885f78d7654642672bfccfae98d57cb",
                    []
                );
                    await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (step 1.5 complete)`);
                return res.send(`<Response></Response>`);
            } else if (state.step === 2) {
                const lcResponse = responseMsg.toLowerCase();
                if (lcResponse === 'yes') {
                    state.step = 3;
                    state.responses.business_location = state.responses.location;
                    await setOnboardingState(from, state);
                    await db.runTransaction(async (transaction) => {
                        const userRef = db.collection('users').doc(from);
                        transaction.update(userRef, {
                            business_province: state.responses.location.province,
                            business_country: state.responses.location.country
                        });
                    });
                        reply = "Please share your email address so I can send you your financial dashboard spreadsheet.";
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (step 2 yes)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                    } else if (lcResponse === 'no') {
                    state.step = 2.5;
                    await setOnboardingState(from, state);
                    reply = "Please provide your business's registered State/Province, Country (e.g., 'Ontario, Canada' or 'Ontario Canada').";
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (step 2 no)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                } else if (lcResponse === 'cancel') {
                    await deleteOnboardingState(from);
                    await db.collection('onboarding').doc(from).delete();
                    await db.runTransaction(async (transaction) => {
                        const userRef = db.collection('users').doc(from);
                        transaction.update(userRef, {
                            onboarding_in_progress: false,
                            name: admin.firestore.FieldValue.delete(),
                            country: admin.firestore.FieldValue.delete(),
                            province: admin.firestore.FieldValue.delete(),
                            email: admin.firestore.FieldValue.delete(),
                            business_province: admin.firestore.FieldValue.delete(),
                            business_country: admin.firestore.FieldValue.delete(),
                            spreadsheetId: admin.firestore.FieldValue.delete()
                        });
                    });
                    reply = "Onboarding cancelled. Reply 'Start Onboarding' to begin again.";
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (step 2 cancel)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                } else {
                    reply = "Please reply with 'Yes', 'No', or 'Cancel' to confirm your business location.";
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (step 2 invalid)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                } else if (state.step === 2.5) {
    // ensure we have something to parse
    if (!responseMsg) {
        reply = "Please provide your business's registered State/Province, Country (e.g., 'Ontario, Canada' or 'Ontario Canada').";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (step 2.5 invalid format)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // prepare validation lists and aliases
    const { knownProvinces, knownCountries } = getValidationLists();
    const countryAliases = {
        'united states': 'USA',
        'us': 'USA',
        'canada': 'Canada'
    };

    // attempt to split on comma or whitespace
    let businessProvince, businessCountry;
    const match = responseMsg.match(/^(.+?)[\s,]+(.+)$/);
    if (match) {
        businessProvince = match[1].trim();
        businessCountry  = match[2].trim();
    } else {
        const parts = responseMsg.trim().split(/\s+/);
        businessCountry  = parts.pop();
        businessProvince = parts.join(' ').trim();
    }

    // normalize common country names
    businessCountry = countryAliases[businessCountry.toLowerCase()] || businessCountry;

    // check against our lists
    let isValidProvince = knownProvinces.some(p => p.toLowerCase() === businessProvince.toLowerCase());
    let isValidCountry  = knownCountries.some(c => c.toLowerCase() === businessCountry.toLowerCase());

    // fuzzy-match or AI-fallback if needed
    if (!isValidProvince || !isValidCountry) {
        // fuzzy province
        if (!isValidProvince) {
            const best = knownProvinces.reduce((best, p) => {
                const score = fuzzball.ratio(p.toLowerCase(), businessProvince.toLowerCase());
                return score > best.score ? { val: p, score } : best;
            }, { val: null, score: 0 });
            if (best.score > 80) {
                console.log(`[FUZZY MATCH] Corrected business province "${businessProvince}" → "${best.val}"`);
                businessProvince = best.val;
                isValidProvince = true;
            }
        }
        // fuzzy country
        if (!isValidCountry) {
            const best = knownCountries.reduce((best, c) => {
                const score = fuzzball.ratio(c.toLowerCase(), businessCountry.toLowerCase());
                return score > best.score ? { val: c, score } : best;
            }, { val: null, score: 0 });
            if (best.score > 80) {
                console.log(`[FUZZY MATCH] Corrected business country "${businessCountry}" → "${best.val}"`);
                businessCountry = best.val;
                isValidCountry = true;
            }
        }

        // AI fallback if still invalid
        if (!isValidProvince || !isValidCountry) {
            state.invalidLocationAttempts = (state.invalidLocationAttempts || 0) + 1;
            if (state.invalidLocationAttempts > 3) {
                reply = "Too many invalid attempts. Please contact support or try again later.";
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (step 2.5 too many attempts)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }
            try {
                const aiRes = await openai.createChatCompletion({
                    model: 'gpt-3.5-turbo',
                    messages: [
                        {
                            role: 'system',
                            content: `Parse this location string: "${responseMsg}". Return JSON: { province: "string", country: "string" }.`
                        },
                        { role: 'user', content: responseMsg }
                    ],
                    max_tokens: 50,
                    temperature: 0.3
                });
                const aiResult = JSON.parse(aiRes.data.choices[0].message.content);
                businessProvince = aiResult.province;
                businessCountry  = aiResult.country;
                if (
                    !knownProvinces.some(p => p.toLowerCase() === businessProvince.toLowerCase()) ||
                    !knownCountries.some(c => c.toLowerCase() === businessCountry.toLowerCase())
                ) {
                    throw new Error("AI returned invalid province or country");
                }
                console.log(`[AI MATCH] Parsed "${responseMsg}" → ${businessProvince}, ${businessCountry}`);
            } catch (err) {
                console.error(`[ERROR] AI parsing failed for ${from}: ${err.message}`);
                reply = "Unable to parse business location. Please use 'State/Province, Country' format.";
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (step 2.5 AI parse failure)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }
        }
    }

    // all good: save and advance
    state.responses.business_location = { province: businessProvince, country: businessCountry };
    state.step = 3;
    await setOnboardingState(from, state);
    await db.runTransaction(transaction => {
        const userRef = db.collection('users').doc(from);
        transaction.update(userRef, {
            business_province: businessProvince,
            business_country: businessCountry
        });
    });

    // Prompt for email and release lock (step 2.5)
reply = "Please share your email address so I can send you your financial dashboard spreadsheet.";
await db.collection('locks').doc(lockKey).delete();
console.log(`[LOCK] Released lock for ${from} (step 2.5 complete)`);
return res.send(`<Response><Message>${reply}</Message></Response>`);
} else if (state.step === 3) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!responseMsg || !emailRegex.test(responseMsg)) {
        reply = "Can I get your email address, so I can send you your financial dashboard spreadsheet?";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (step 3 invalid email)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Save email & mark onboarding complete
    state.responses.email = responseMsg;
    userProfileData.email = responseMsg;
    await setOnboardingState(from, state);
    await db.runTransaction(async (transaction) => {
        const userRef = db.collection('users').doc(from);
        await transaction.update(userRef, {
            email: responseMsg,
            onboarding_in_progress: false,
            onboarding_completed: true
        });
    });

    // Build congratulatory message
    const name = userProfileData.name || "there";
    const congratsPart1 = `Congratulations ${name}!
        You’ve now got a personal CFO — in your pocket — on demand.
        Real-time. Data-smart. Built to make your business *make sense*.

        📈 We’re talking:
        — Auto-tracking your money
        — Instant profit breakdowns
        — No more “where did it all go?”
        — Absolute clarity on every move 💸

        Start simple. Try messages like:

        🧱 Starting a Job:
        Start Jack's renovation today

        🧾 Logging an Expense:
        Spent $980 at Home Depot for lumber

        🚚 Adding a Monthly Bill:
        Add monthly truck payment $760

        💬 Getting Answers:
        What do I need to earn this month to pay all of my bills?

        ⏱ Tracking Hours:
        Clock in  
        Break time  
        Clock out

        🛠 Pausing a Job:
        Pause Jack's renovation to do a repair

        ✅ Finishing a Job:
        Finished Jack's renovation

        💵 Logging Revenue:
        Got a $7,500 payment from Jack.

        📊 Getting Metrics:
        How long did it take to complete Jack's job and how much did I make?`

        const congratsPart2 = `Here’s how I’d break it down:

        📊 Job Summary: Jack’s Renovation
        Duration: 9 days (May 6–May 15)
        Total Hours Logged: 78 hours
        Crew Members: 2 (Scott + Mike)

        💵 Revenue:
        $7,500 payment received

        📉 Expenses:
        • Lumber – $980
        • Disposal Bin – $420
        • Paint & Supplies – $310
        • Labor (Mike, 40 hrs @ $25/hr) – $1,000
        • Gas & Travel – $150
        • Tools & Sundries – $90
        Total Expenses: $2,950

        🧠 Profit Breakdown:
        • Net Profit: $4,550
        • Profit Margin: 60.7%
        • Daily Profit Avg: $505.56
        • Your Effective Hourly Rate: $58.33/hr

        💡 Insight:
        Jack’s job had a strong margin. Labour was efficient. Materials were the largest cost — worth revisiting for future savings.
        All of this without an additional app, or software. Just record a voice message or type it out and send it... we'll do the rest. 
                     
        🎥 A quick walkthrough video is on its way.
        But the real learning happens when you start using me.

        You just leveled up.
        Let’s build something great.
        — Chief 💼`;

    try {
        // Create sheet, email it, and send the sheet link via template
        const spreadsheetId = await createSpreadsheetForUser(from, responseMsg);
        await sendSpreadsheetEmail(responseMsg, spreadsheetId);
        await sendTemplateMessage(
            from,
            "HXf5964d5ffeecc5e7f4e94d7b3379e084",
            [{ type: "text", text: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` }]
        );

        // Clean up onboarding state
        await deleteOnboardingState(from);

        // Send congrats messages as regular WhatsApp messages
        const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        
        // Send Part 1
        const message1 = await twilioClient.messages.create({
            body: congratsPart1,
            from: 'whatsapp:+12316802664',
            to: `whatsapp:${from}`
        });
        console.log(`[DEBUG] Congrats message part 1 sent to ${from}, SID: ${message1.sid}, length: ${congratsPart1.length}`);

        // Add a slight delay to ensure sequential delivery
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Send Part 2
        const message2 = await twilioClient.messages.create({
            body: congratsPart2,
            from: 'whatsapp:+12316802664',
            to: `whatsapp:${from}`
        });
        console.log(`[DEBUG] Congrats message part 2 sent to ${from}, SID: ${message2.sid}, length: ${congratsPart2.length}`);

        // Release the lock
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (step 3 complete)`);

        // Send minimal TwiML response
    } catch (error) {
        console.error(`[ERROR] Failed to process spreadsheet or messages for ${from}: ${error.message}`, error.stack);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (step 3 error)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
            
                } else if (state.dynamicStep === 'industry') {
                if (!responseMsg) {
                    reply = "Please provide your industry (e.g., Construction, Freelancer).";
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (industry invalid)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                userProfileData.industry = responseMsg;
                await db.runTransaction(async (transaction) => {
                    const userRef = db.collection('users').doc(from);
                    transaction.update(userRef, { industry: responseMsg });
                });
                    reply = `Got it, ${userProfileData.name}! Industry set to ${responseMsg}. Keep logging—next up, I’ll ask your financial goal when you add a bill or revenue.`;
                await deleteOnboardingState(from);
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (industry set)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            } else if (state.dynamicStep === 'goal') {
                if (!responseMsg) {
                    reply = "Please provide your financial goal (e.g., 'Grow profit by $10,000').";
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (goal invalid)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                userProfileData.goal = responseMsg;
                userProfileData.goalProgress = {
                    target: responseMsg.includes('debt')
                        ? -parseFloat(responseMsg.match(/\d+/)?.[0] || 5000) * 1000
                        : parseFloat(responseMsg.match(/\d+/)?.[0] || 10000) * 1000,
                    current: 0
                };
                await db.runTransaction(async (transaction) => {
                    const userRef = db.collection('users').doc(from);
                    transaction.update(userRef, {
                        goal: responseMsg,
                        goalProgress: userProfileData.goalProgress
                    });
                });
                    const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
                reply = `Goal locked in: "${responseMsg}" (${currency} ${userProfileData.goalProgress.target.toFixed(2)}). You’re unstoppable, ${userProfileData.name}! Check "Goal" anytime to track it.`;
                await deleteOnboardingState(from);
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (goal set)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            } else {
                console.error(`[ERROR] Unknown onboarding step for ${from}: step=${state.step}`);
                reply = "It looks like something went wrong. Please respond to the previous onboarding question.";
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (unknown step)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }
        }

        // Handle completed users attempting to restart onboarding
        if (userProfileData.onboarding_completed && body?.trim().toLowerCase() === 'start onboarding') {
            reply = "You've already completed onboarding.";
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (onboarding already completed)`);
            return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        
        
           // Non-onboarding flow
           if (!userProfileData.onboarding_in_progress) {
            console.log(`[INFO] User ${from} is not in onboarding: onboarding_in_progress=${userProfileData.onboarding_in_progress}`);
            const state = await getOnboardingState(from);
            if (state && state.step > 0) {
                console.error(`[ERROR] Inconsistent onboarding state for ${from}: onboarding_in_progress=${userProfileData.onboarding_in_progress}, state.step=${state.step}`);
                await db.runTransaction(async (transaction) => {
                    const userRef = db.collection('users').doc(from);
                    transaction.update(userRef, { onboarding_in_progress: true });
                });
                let reply = "It looks like your onboarding was interrupted. Please respond to the previous onboarding question.";
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (inconsistent state)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }

            const pendingState = await getPendingTransactionState(from);
            const spreadsheetId = ownerProfile.spreadsheetId;
            let reply;

            // Check for onboarding restart intent
            const onboardingTriggers = ['start', 'hi', 'hello', 'hey', 'begin'];
            if (onboardingTriggers.includes(body.toLowerCase())) {
                // Reset user profile for fresh onboarding
                await db.runTransaction(async (transaction) => {
                    const userRef = db.collection('users').doc(from);
                    transaction.update(userRef, {
                        onboarding_in_progress: true,
                        name: admin.firestore.FieldValue.delete(),
                        country: admin.firestore.FieldValue.delete(),
                        province: admin.firestore.FieldValue.delete(),
                        email: admin.firestore.FieldValue.delete(),
                        business_province: admin.firestore.FieldValue.delete(),
                        business_country: admin.firestore.FieldValue.delete()
                    });
                });
                // Ensure onboarding state is cleared
                await db.collection('onboarding').doc(from).delete();
                // Set initial onboarding state
                const newState = {
                    step: 0,
                    responses: {},
                    detectedLocation: {
                        country: userProfileData?.country || "Unknown Country",
                        province: userProfileData?.province || "Unknown Province"
                    }
                };
                await setOnboardingState(from, newState);
                reply = "Welcome! What's your name?";
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (onboarding restart)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }

            if (withinLimit.exceeded) {
                reply = "⚠️ Trial limit reached! Reply 'Upgrade' to continue.";
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (trial limit exceeded)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }
            if (!userName || userName === 'Unknown User') {
                reply = "⚠️ Your name is missing. Please reply with your name to continue.";
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (missing name)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }
            if (body.toLowerCase() === "team") {
                const teamInfo = await getTeamInfo(ownerId);
                if (teamInfo && teamInfo.teamMembers.length > 0) {
                    reply = `Your team: ${teamInfo.teamMembers.map(m => `${m.name} (${m.phone})`).join(", ")}`;
                } else {
                    reply = "No team members yet. Reply 'Add [name] [phone]' to add one.";
                }
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (team command)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }
            if (isOwner && body.toLowerCase().startsWith("add ")) {
                const addMatch = body.match(/add\s+(.+?)\s+\+(\d{10,11})\s+as\s+a\s+team\s+member/i);
                if (addMatch) {
                    const memberName = addMatch[1].trim();
                    const memberPhone = addMatch[2];
                    await addTeamMember(from, memberName, memberPhone);
                    const sent = await sendTemplateMessage(
                        memberPhone,
                        confirmationTemplates.teamMemberInvite,
                        [
                            { type: "text", text: memberName },
                            { type: "text", text: ownerProfile.name }
                        ]
                    );
                    reply = sent
                        ? `✅ Invited ${memberName} (${memberPhone}) to your team. They’ll need to reply with their name to join.`
                        : `✅ Added ${memberName} (${memberPhone}) to your team, but couldn’t send the invite message.`;
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (add team member)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                reply = `⚠️ Invalid format. Use: "Add John Doe +19058884444 as a team member"`;
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (invalid add format)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            } else if (isOwner && body.toLowerCase().startsWith("remove ")) {
                const removeMatch = body.match(/remove\s+\+(\d{10,11})\s+from\s+my\s+team/i);
                if (removeMatch) {
                    const memberPhone = removeMatch[1];
                    await removeTeamMember(from, memberPhone);
                    reply = `✅ Removed ${memberPhone} from your team.`;
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (remove team member)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                reply = `⚠️ Invalid format. Use: "Remove +19058884444 from my team"`;
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (invalid remove format)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            } else if (!isOwner && (body.toLowerCase().startsWith("add ") || body.toLowerCase().startsWith("remove "))) {
                reply = `⚠️ Only the owner can manage team members.`;
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (team management not owner)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }
            if (pendingState && pendingState.pendingDelete) {
                if (!isOwner) {
                    await deletePendingTransactionState(from);
                    reply = `⚠️ Only the owner can delete entries.`;
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (pending delete not owner)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                if (body.toLowerCase() === 'yes') {
                    const { type, rowIndex, sheetName } = pendingState.pendingDelete;
                    const auth = await getAuthorizedClient();
                    const sheets = google.sheets({ version: 'v4', auth });

                    await sheets.spreadsheets.values.update({
                        spreadsheetId,
                        range: `${sheetName}!A${rowIndex + 2}:I${rowIndex + 2}`,
                        valueInputOption: 'RAW',
                        resource: { values: [[]] }
                    });

                    await deletePendingTransactionState(from);
                    reply = `✅ Deleted ${type} entry successfully.`;
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (pending delete confirmed)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                } else if (body.toLowerCase() === 'no' || body.toLowerCase() === 'cancel') {
                    await deletePendingTransactionState(from);
                    reply = "❌ Deletion cancelled.";
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (pending delete cancelled)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                } else {
                    reply = "⚠️ Please reply with 'yes' or 'no' to confirm deletion.";
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (pending delete invalid response)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
            }
            if (pendingState && pendingState.pendingQuote) {
                if (!isOwner) {
                    await deletePendingTransactionState(from);
                    reply = `⚠️ Only the owner can generate quotes.`;
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (pending quote not owner)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                const { jobName, items, total, isFixedPrice, description } = pendingState.pendingQuote;
                const customerInput = body.trim();
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                const customerName = emailRegex.test(customerInput) ? 'Email Provided' : customerInput;
                const customerEmail = emailRegex.test(customerInput) ? customerInput : null;

                const taxRate = getTaxRate(userProfileData.country, userProfileData.province);
                const subtotal = total;
                const tax = subtotal * taxRate;
                const totalWithTax = subtotal + tax;
                const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';

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

                const auth = await getAuthorizedClient();
                const drive = google.drive({ version: 'v3', auth });
                const fileName = `Quote_${jobName}_${Date.now()}.pdf`;
                const fileMetadata = { name: fileName };
                const media = {
                    mimeType: 'application/pdf',
                    body: fs.createReadStream(outputPath),
                };
                
                const driveResponse = await drive.files.create({
                    resource: fileMetadata,
                    media,
                    fields: 'id, webViewLink',
                });
                await drive.permissions.create({
                    fileId: driveResponse.data.id,
                    requestBody: { role: 'reader', type: 'anyone' },
                });
                const pdfUrl = driveResponse.data.webViewLink;

                await deletePendingTransactionState(from);

                reply = `✅ Quote for ${jobName} generated.\nSubtotal: ${currency} ${subtotal.toFixed(2)}\nTax (${(taxRate * 100).toFixed(2)}%): ${currency} ${tax.toFixed(2)}\nTotal: ${currency} ${totalWithTax.toFixed(2)}\nCustomer: ${customerName}\nDownload here: ${pdfUrl}`;
                if (customerEmail) {
                    await sendSpreadsheetEmail(customerEmail, driveResponse.data.id, 'Your Quote');
                    reply += `\nAlso sent to ${customerEmail}`;
                }
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (pending quote processed)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }
            if (body.toLowerCase().startsWith("edit bill ")) {
                if (!isOwner) {
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (edit bill not owner)`);
                    return res.send(`<Response><Message>⚠️ Only the owner can edit bills.</Message></Response>`);
                }
                const match = body.match(/edit bill\s+(.+?)(?:\s+amount\s+(\$?\d+\.?\d*))?(?:\s+due\s+(.+?))?(?:\s+(yearly|monthly|weekly|bi-weekly|one-time))?/i);
                if (!match) {
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (edit bill invalid format)`);
                    return res.send(`<Response><Message>⚠️ Format: "Edit bill [name] [amount $X] [due date] [recurrence]" (e.g., "Edit bill Rent amount $600 due June 1st monthly")</Message></Response>`);
                }
                const [, billName, amount, dueDate, recurrence] = match;
                const billData = {
                    billName,
                    date: new Date().toISOString().split('T')[0],
                    amount: amount ? `$${parseFloat(amount.replace('$', '')).toFixed(2)}` : null,
                    dueDate: dueDate || null,
                    recurrence: recurrence || null
                };
                const success = await updateBillInSheets(ownerId, billData);
                reply = success 
                    ? `✅ Bill "${billName}" updated${amount ? ` to ${billData.amount}` : ''}${dueDate ? ` due ${dueDate}` : ''}${recurrence ? ` (${recurrence})` : ''}.`
                    : `⚠️ Bill "${billName}" not found or update failed.`;
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (edit bill processed)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            }
            if (body.toLowerCase().startsWith("delete bill ")) {
                if (!isOwner) {
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (delete bill not owner)`);
                    return res.send(`<Response><Message>⚠️ Only the owner can delete bills.</Message></Response>`);
                }
                const billName = body.replace(/^delete bill\s+/i, '').trim();
                await setPendingTransactionState(from, { pendingDelete: { type: 'bill', billName } });
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (delete bill prompt)`);
                return res.send(`<Response><Message>Are you sure you want to delete bill "${billName}"? Reply 'yes' or 'no'.</Message></Response>`);
            }
            if (pendingState && pendingState.pendingDelete) {
                if (!isOwner) {
                    await deletePendingTransactionState(from);
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (pending delete not owner)`);
                    return res.send(`<Response><Message>⚠️ Only the owner can delete entries.</Message></Response>`);
                }
                if (body.toLowerCase() === 'yes') {
                    const { type, billName, rowIndex } = pendingState.pendingDelete;
                    if (type === 'bill') {
                        const success = await deleteBillInSheets(ownerId, billName);
                        reply = success ? `✅ Bill "${billName}" deleted.` : `⚠️ Bill "${billName}" not found or deletion failed.`;
                    } else {
                        const sheets = google.sheets({ version: 'v4', auth: await getAuthorizedClient() });
                        const sheetName = type === 'revenue' ? 'Revenue' : 'Sheet1';
                        await sheets.spreadsheets.values.update({
                            spreadsheetId,
                            range: `${sheetName}!A${rowIndex + 2}:I${rowIndex + 2}`,
                            valueInputOption: 'RAW',
                            resource: { values: [[]] }
                        });
                        reply = `✅ Deleted ${type} entry successfully.`;
                    }
                    await deletePendingTransactionState(from);
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (pending delete confirmed)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                } else if (body.toLowerCase() === 'no' || body.toLowerCase() === 'cancel') {
                    await deletePendingTransactionState(from);
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (pending delete cancelled)`);
                    return res.send(`<Response><Message>❌ Deletion cancelled.</Message></Response>`);
                } else {
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (pending delete invalid response)`);
                    return res.send(`<Response><Message>⚠️ Please reply with 'yes' or 'no' to confirm deletion.</Message></Response>`);
                }
            }

                // 3. Chief Message Handling
                if (input.toLowerCase() === "chief!!") {
                    await setPendingTransactionState(from, { pendingChiefMessage: true });
                    return res.send(`<Response><Message>Please write your message for Scott, and I'll send it to him!</Message></Response>`);
                }
                else if (pendingState && pendingState.pendingChiefMessage) {
                    const userMessage = input.trim();
                    const senderName = userName || 'Unknown User';
                    const senderPhone = from;

                    try {
                        await sendEmail({
                            to: 'scottejutras@gmail.com',
                            from: 'scott@scottjutras.com',
                            subject: `Message from ${senderName} (${senderPhone})`,
                            text: `From: ${senderName} (${senderPhone})\n\nMessage:\n${userMessage}`
                        });
                        await deletePendingTransactionState(from);
                        return res.send(`<Response><Message>✅ Your message has been sent to Scott! He'll get back to you soon.</Message></Response>`);
                    } catch (error) {
                        console.error('[ERROR] Failed to send Chief message:', error);
                        await deletePendingTransactionState(from);
                        return res.send(`<Response><Message>⚠️ Sorry, something went wrong sending your message. Please try again later.</Message></Response>`);
                    }
                }

                // 4. Pending Confirmations for Expense, Revenue, or Bill
                if (pendingState && (pendingState.pendingExpense || pendingState.pendingRevenue || pendingState.pendingBill)) {
                    const pendingData = pendingState.pendingExpense || pendingState.pendingRevenue || pendingState.pendingBill;
                    const type = pendingState.pendingExpense ? 'expense' : pendingState.pendingRevenue ? 'revenue' : 'bill';
                    const activeJob = await getActiveJob(ownerId) || "Uncategorized";

                    if (input && input.toLowerCase() === 'yes') {
                        const category = pendingData.suggestedCategory || await categorizeEntry(type, pendingData, ownerProfile);
                        if (type === 'expense') {
                            await appendToUserSpreadsheet(ownerId, [pendingData.date, pendingData.item, pendingData.amount, pendingData.store, activeJob, 'expense', category, mediaUrl || '', userName]);
                        } else if (type === 'revenue') {
                            await appendToUserSpreadsheet(ownerId, [pendingData.date, pendingData.description, pendingData.amount, pendingData.source || pendingData.client, activeJob, 'revenue', category, '', userName]);
                        } else if (type === 'bill') {
                            await appendToUserSpreadsheet(ownerId, [pendingData.date, pendingData.billName, pendingData.amount, pendingData.recurrence, activeJob, 'bill', category, '', userName]);
                        }
                        await deletePendingTransactionState(from);
                        reply = `✅ ${type} logged: ${pendingData.amount} ${type === 'expense' ? `for ${pendingData.item} from ${pendingData.store}` : type === 'revenue' ? `from ${pendingData.source || pendingData.client}` : `for ${pendingData.billName}`} on ${pendingData.date} by ${userName} (Category: ${category})`;
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    } else if (input && (input.toLowerCase() === 'no' || input.toLowerCase() === 'edit')) {
                        reply = "✏️ Okay, please resend the correct details.";
                        await setPendingTransactionState(from, { isEditing: true, type });
                        await deletePendingTransactionState(from);
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    } else if (input && input.toLowerCase() === 'cancel') {
                        await deletePendingTransactionState(from);
                        reply = "❌ Transaction cancelled.";
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    } else {
                        const errors = detectErrors(pendingData, type);
                        const category = await categorizeEntry(type, pendingData, ownerProfile);
                        pendingData.suggestedCategory = category;
                        if (errors) {
                            const corrections = await correctErrorsWithAI(errors);
                            if (corrections) {
                                await setPendingTransactionState(from, {
                                    [type === 'expense' ? 'pendingExpense' : type === 'revenue' ? 'pendingRevenue' : 'pendingBill']: pendingData,
                                    pendingCorrection: true,
                                    suggestedCorrections: corrections,
                                    type
                                });
                                const correctionText = Object.entries(corrections).map(([k, v]) => `${k}: ${pendingData[k] || 'missing'} → ${v}`).join('\n');
                                reply = `🤔 Issues detected:\n${correctionText}\nReply 'yes' to accept or 'no' to edit.\nSuggested Category: ${category}`;
                                return res.send(`<Response><Message>${reply}</Message></Response>`);
                            }
                        }
                        reply = `⚠️ Please respond with 'yes', 'no', 'edit', or 'cancel' to proceed.\nSuggested Category: ${category}`;
                        const sent = await sendTemplateMessage(
                            from,
                            type === 'expense' || type === 'bill' ? confirmationTemplates.expense : confirmationTemplates.revenue,
                            { "1": `Please confirm: ${type === 'expense' || type === 'bill' ? `${pendingData.amount} for ${pendingData.item || pendingData.source || pendingData.billName} on ${pendingData.date}` : `Revenue of ${pendingData.amount} from ${pendingData.source} on ${pendingData.date}`} (Category: ${category})` }
                        );
                        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                }

                // 5. Start Job Command (Owner Only)
                else if (input && /^(start job|job start)\s+(.+)/i.test(input)) {
                    if (!isOwner) {
                        return res.send(`<Response><Message>⚠️ Only the owner can start jobs.</Message></Response>`);
                    }
                    const defaultData = { jobName: "Unknown Job" };
                    const { data, reply, confirmed } = await handleInputWithAI(
                        from,
                        input,
                        'job',
                        (input) => {
                            const match = input.match(/^(start job|job start)\s+(.+)/i);
                            return match ? { jobName: match[2].trim() } : null;
                        },
                        defaultData
                    );

                    if (reply) {
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }

                    if (data && data.jobName && confirmed) {
                        await setActiveJob(from, data.jobName);
                        const sent = await sendTemplateMessage(from, confirmationTemplates.startJob, [{ type: "text", text: data.jobName }]);
                        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>✅ Job '${data.jobName}' started.</Message></Response>`);
                    }
                }

                // 6. Finish Job Command (Owner Only)
                else if (input && input.toLowerCase().startsWith("finish job ")) {
                    if (!isOwner) {
                        return res.send(`<Response><Message>⚠️ Only the owner can finish jobs.</Message></Response>`);
                    }
                    const jobName = input.replace(/^finish job\s+/i, '').trim();
                    const activeJob = await getActiveJob(ownerId);
                    if (activeJob !== jobName) {
                        return res.send(`<Response><Message>⚠️ No active job named '${jobName}'.</Message></Response>`);
                    }
                    await finishJob(ownerId, jobName);
                    const userRef = db.collection('users').doc(ownerId);
                    const doc = await userRef.get();
                    const job = doc.data().jobHistory.find(j => j.jobName === jobName);
                    const durationDays = Math.round((new Date(job.endTime) - new Date(job.startTime)) / (1000 * 60 * 60 * 24));
                    const sheets = google.sheets({ version: 'v4', auth: await getAuthorizedClient() });
                    const expenseData = await sheets.spreadsheets.values.get({
                        spreadsheetId: ownerProfile.spreadsheetId,
                        range: 'Sheet1!A:I'
                    });
                    const revenueData = await sheets.spreadsheets.values.get({
                        spreadsheetId: ownerProfile.spreadsheetId,
                        range: 'Revenue!A:I'
                    });
                    const expenses = expenseData.data.values.slice(1).filter(row => row[4] === jobName);
                    const revenues = revenueData.data.values.slice(1).filter(row => row[4] === jobName);
                    const totalExpenses = expenses.reduce((sum, row) => sum + parseFloat(row[2].replace('$', '')), 0);
                    const totalRevenue = revenues.reduce((sum, row) => sum + parseFloat(row[2].replace('$', '')), 0);
                    const profit = totalRevenue - totalExpenses;
                    const profitPerDay = profit / durationDays || 0;
                    const revenuePerDay = totalRevenue / durationDays || 0;
                    const hoursWorked = durationDays * 8;
                    const profitPerHour = profit / hoursWorked || 0;
                    reply = `✅ Job '${jobName}' finished after ${durationDays} days.\nRevenue: $${revenuePerDay.toFixed(2)}/day\nProfit: $${profitPerDay.toFixed(2)}/day\nHourly Profit: $${profitPerHour.toFixed(2)}/hour`;
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }

                // 7. Add, Update and Delete Bill Command
            if (input && input.toLowerCase().includes("bill") && !input.toLowerCase().includes("delete")) {
                console.log("[DEBUG] Detected a bill message:", input);
                const activeJob = await getActiveJob(ownerId) || "Uncategorized";
                const defaultData = { date: new Date().toISOString().split('T')[0], billName: "Unknown", amount: "$0.00", recurrence: "one-time", dueDate: "Unknown" };

                let state = await getOnboardingState(from);
                if (!userProfileData.goal && !state?.dynamicStep) {
                    await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'goal' });
                    reply = "What’s your financial goal, boss? (e.g., Grow profit by $10,000, Pay off $5,000 debt)";
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                if (state?.dynamicStep === 'goal') {
                    userProfileData.goal = input;
                    if (!input.match(/\d+/) || (!input.includes('profit') && !input.includes('debt'))) {
                        reply = "⚠️ That doesn’t look like a goal. Try 'Grow profit by $10,000' or 'Pay off $5,000 debt'.";
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                    userProfileData.goalProgress = { 
                        target: input.includes('debt') ? -parseFloat(input.match(/\d+/)?.[0] || 5000) * 1000 : parseFloat(input.match(/\d+/)?.[0] || 10000) * 1000, 
                        current: 0 
                    };
                    await saveUserProfile(userProfileData);
                    const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
                    reply = `Goal locked in: "${input}" (${currency} ${userProfileData.goalProgress.target.toFixed(2)}). You’re unstoppable, ${userProfileData.name}!`;
                    await deleteOnboardingState(from);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }

                const { data, reply: aiReply, confirmed } = await handleInputWithAI(
                    from,
                    input,
                    'bill',
                    (input) => {
                        const billRegex = /bill\s+([\w\s]+)\s+\$([\d,]+(?:\.\d{1,2})?)\s+(?:per\s+)?(\w+)?\s*(?:on|due)\s+([\w\d\s,-]+)/i;
                        const match = input.match(billRegex);
                        if (match) {
                            return {
                                date: new Date().toISOString().split('T')[0],
                                billName: match[1].trim(),
                                amount: `$${parseFloat(match[2].replace(/,/g, '')).toFixed(2)}`,
                                recurrence: match[3] ? (match[3].toLowerCase() === "month" ? "monthly" : match[3]) : "one-time",
                                dueDate: match[4].trim()
                            };
                        }
                        return null;
                    },
                    defaultData
                );

                if (aiReply) {
                    return res.send(`<Response><Message>${aiReply}</Message></Response>`);
                }

                if (data && data.billName && data.amount && data.amount !== "$0.00" && data.dueDate && confirmed) {
                    const refinedDueDate = data.dueDate.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})/i)
                        ? `${data.dueDate.match(/(\w+)/)[1]} ${parseInt(data.dueDate.match(/(\d{1,2})/)[1]) === 1 ? "1st" : "2nd"}`
                        : data.dueDate;
                    const category = await categorizeEntry('bill', data, ownerProfile);
                    await setPendingTransactionState(from, { pendingBill: { ...data, dueDate: refinedDueDate, suggestedCategory: category } });
                    const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
                    const sent = await sendTemplateMessage(from, confirmationTemplates.bill, {
                        "1": `${currency} ${parseFloat(data.amount.replace(/[^0-9.]/g, '')).toFixed(2)}`,
                        "2": refinedDueDate,
                        "3": data.recurrence.charAt(0).toUpperCase() + data.recurrence.slice(1)
                    });
                    return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>⚠️ Failed to send bill confirmation.</Message></Response>`);
                }
            }


// 8. Revenue Logging Branch
else if (input && input.toLowerCase().includes("received")) {
    console.log(`[DEBUG] Detected a revenue message: "${input}"`);
    
    // Check for expense/revenue triggers
    if (!isValidExpenseInput(input)) {
        console.log(`[INFO] Non-revenue input detected for ${from}: input="${input}"`);
        reply = `🤔 I didn't understand "${input}". Please provide a valid revenue input (e.g., "received $100 from John") or reply 'start' to begin onboarding.`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (invalid non-revenue input)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    const activeJob = await getActiveJob(ownerId) || "Uncategorized";
    const defaultData = { date: new Date().toISOString().split('T')[0], description: "Payment", amount: "$0.00", source: "Unknown Client" };

    let state = await getOnboardingState(from);
    if (!userProfileData.goal && !state?.dynamicStep) {
        await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'goal' });
        reply = "What’s your financial goal, boss? (e.g., Grow profit by $10,000, Pay off $5,000 debt)";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (goal onboarding)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (state?.dynamicStep === 'goal') {
        userProfileData.goal = input;
        userProfileData.goalProgress = { 
            target: input.includes('debt') ? -parseFloat(input.match(/\d+/)?.[0] || 5000) * 1000 : parseFloat(input.match(/\d+/)?.[0] || 10000) * 1000, 
            current: 0 
        };
        await saveUserProfile(userProfileData);
        const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
        reply = `Goal locked in: "${input}" (${currency} ${userProfileData.goalProgress.target.toFixed(2)}). You’re unstoppable, ${userProfileData.name}! Now, let’s log that revenue.`;
        await deleteOnboardingState(from);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (goal set)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    const { data, reply: aiReply, confirmed } = await handleInputWithAI(from, input, 'revenue', parseRevenueMessage, defaultData);

    if (aiReply) {
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (revenue input reply)`);
        return res.send(`<Response><Message>${aiReply}</Message></Response>`);
    }

    if (data && data.amount && data.amount !== "$0.00") {
        const category = await categorizeEntry('revenue', data, ownerProfile);
        data.suggestedCategory = category;
        const taxRate = getTaxRate(userProfileData.country, userProfileData.province);
        const amount = parseFloat(data.amount.replace(/[^0-9.]/g, ''));
        const taxAmount = amount * taxRate;
        const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';

        if (confirmed) {
            reply = await appendToUserSpreadsheet(ownerId, [data.date, data.description, data.amount, data.source || data.client, activeJob, 'revenue', category, '', userName]);
            reply += `. Tax: ${currency} ${taxAmount.toFixed(2)} (${(taxRate * 100).toFixed(2)}%)`;
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (revenue logged)`);
            return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
        } else {
            await setPendingTransactionState(from, { pendingRevenue: data });
            reply = `Revenue: ${currency} ${amount.toFixed(2)} from ${data.source || data.client}. Tax: ${currency} ${taxAmount.toFixed(2)} (${(taxRate * 100).toFixed(2)}%)`;
            const sent = await sendTemplateMessage(from, confirmationTemplates.revenue, {
                "1": `${reply} on ${data.date} (Category: ${category})`
            });
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (pending revenue)`);
            return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>⚠️ Failed to send revenue confirmation.</Message></Response>`);
        }
    }
    reply = `🤔 Couldn’t parse a valid revenue from "${input}". Please try again with a format like "received $100 from John".`;
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (invalid revenue)`);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
}
            // Quick Matches for Expense, Revenue, Bill
else if (input) {
    console.log(`[DEBUG] Attempting quick match for ${from}: "${input}"`);

    // Check for onboarding triggers
    if (isOnboardingTrigger(input)) {
        console.log(`[INFO] Onboarding trigger detected in quick match for ${from}: input="${input}"`);
        if (userProfileData.onboarding_in_progress) {
            reply = "Please respond to the current onboarding question or cancel to restart.";
        } else {
            // Trigger onboarding restart
            await db.runTransaction(async (transaction) => {
                const userRef = db.collection('users').doc(from);
                transaction.update(userRef, {
                    onboarding_in_progress: true,
                    name: admin.firestore.FieldValue.delete(),
                    country: admin.firestore.FieldValue.delete(),
                    province: admin.firestore.FieldValue.delete(),
                    email: admin.firestore.FieldValue.delete(),
                    business_province: admin.firestore.FieldValue.delete(),
                    business_country: admin.firestore.FieldValue.delete(),
                    spreadsheetId: admin.firestore.FieldValue.delete(),
                    onboarding_completed: admin.firestore.FieldValue.delete()
                });
            });
            await db.collection('onboarding').doc(from).delete();
            const newState = {
                step: 0,
                responses: {},
                detectedLocation: {
                    country: userProfileData?.country || "Unknown Country",
                    province: userProfileData?.province || "Unknown Province"
                }
            };
            await setOnboardingState(from, newState);
            reply = "Welcome! What's your name?";
        }
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding trigger in quick match)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Check for valid commands
    if (isValidCommand(input)) {
        console.error(`[ERROR] Unhandled command in quick match for ${from}: ${input}`);
        reply = `⚠️ Command "${input}" was not processed correctly. Please try again.`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (unhandled command in quick match)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Check for expense/revenue/bill triggers
    if (!isValidExpenseInput(input)) {
        console.log(`[INFO] Non-expense/revenue/bill input detected in quick match for ${from}: input="${input}"`);
        reply = `🤔 I didn't understand "${input}". Please provide a valid command (e.g., "team", "edit bill", "expense $100 tools") or reply 'start' to begin onboarding.`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (invalid input in quick match)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    const expenseMatch = input.match(/^(?:expense\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
    const revenueMatch = input.match(/^(?:revenue\s+)?(?:received\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(?:from\s+)?(.+)/i);
    const billMatch = input.match(/^bill\s+(.+?)\s+\$?(\d+(?:\.\d{1,2})?)\s+(yearly|monthly|weekly|bi-weekly|one-time)$/i);

    let state = await getOnboardingState(from);
    if (expenseMatch && !userProfileData.industry && !state?.dynamicStep) {
        await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'industry' });
        reply = "Hey, what industry are you in? (e.g., Construction, Freelancer)";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (industry onboarding)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (state?.dynamicStep === 'industry') {
        userProfileData.industry = input;
        await saveUserProfile(userProfileData);
        reply = `Got it, ${userProfileData.name}! Industry set to ${input}. Keep logging—next up, I’ll ask your financial goal when you add a bill or revenue.`;
        await deleteOnboardingState(from);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (industry set)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (billMatch && !userProfileData.goal && !state?.dynamicStep) {
        await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'goal' });
        reply = "What’s your financial goal, boss? (e.g., Grow profit by $10,000, Pay off $5,000 debt)";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (goal onboarding)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (state?.dynamicStep === 'goal') {
        userProfileData.goal = input;
        userProfileData.goalProgress = { 
            target: input.includes('debt') ? -parseFloat(input.match(/\d+/)?.[0] || 5000) * 1000 : parseFloat(input.match(/\d+/)?.[0] || 10000) * 1000, 
            current: 0 
        };
        await saveUserProfile(userProfileData);
        const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
        reply = `Goal locked in: "${input}" (${currency} ${userProfileData.goalProgress.target.toFixed(2)}). You’re unstoppable, ${userProfileData.name}!`;
        await deleteOnboardingState(from);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (goal set)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    if (expenseMatch) {
        const [, amount, item, store] = expenseMatch;
        const date = new Date().toISOString().slice(0, 10);
        const activeJob = await getActiveJob(ownerId) || "Uncategorized";
        const category = await categorizeEntry('expense', { amount, item, store, date }, ownerProfile);
        reply = await appendToUserSpreadsheet(ownerId, [date, item, amount, store || '', activeJob, 'expense', category, mediaUrl || '', userName]);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (expense logged)`);
        return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
    } else if (revenueMatch) {
        const [, amount, source] = revenueMatch;
        const date = new Date().toISOString().slice(0, 10);
        const activeJob = await getActiveJob(ownerId) || "Uncategorized";
        const category = await categorizeEntry('revenue', { amount, description: source, date }, ownerProfile);
        reply = await appendToUserSpreadsheet(ownerId, [date, source, amount, source, activeJob, 'revenue', category, '', userName]);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (revenue logged)`);
        return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
    } else if (billMatch) {
        const [, billName, amount, recurrence] = billMatch;
        const date = new Date().toISOString().slice(0, 10);
        const activeJob = await getActiveJob(ownerId) || "Uncategorized";
        const category = await categorizeEntry('bill', { billName, amount, recurrence, date }, ownerProfile);
        reply = await appendToUserSpreadsheet(ownerId, [date, billName, amount, recurrence, activeJob, 'bill', category, '', userName]);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (bill logged)`);
        return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
    } else {
        // Fallback to Text Expense Logging if no quick match
        console.log(`[INFO] No quick match found for ${from}: "${input}", falling back to text expense logging`);
        // The Text Expense Logging block (section 14) will handle this
    }
}

            // Additional Commands (#5 UX Polish)
            if (input.toLowerCase().startsWith("stats")) {
                try {
                    const sheets = google.sheets({ version: 'v4', auth: await getAuthorizedClient() });
                    const expenses = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Sheet1!A:I' });
                    const revenues = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Revenue!A:I' });
                    const expenseData = expenses.data.values?.slice(1).filter(row => row[5] === 'expense') || [];
                    const revenueData = revenues.data.values?.slice(1) || [];
                    const totalExpenses = expenseData.reduce((sum, row) => sum + parseFloat(row[2].replace(/[^0-9.]/g, '') || 0), 0);
                    const totalRevenue = revenueData.reduce((sum, row) => sum + parseFloat(row[2].replace(/[^0-9.]/g, '') || 0), 0);
                    const profit = totalRevenue - totalExpenses;
                    const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
                    reply = `📊 Your Stats, ${userName}:\nRevenue: ${currency} ${totalRevenue.toFixed(2)}\nExpenses: ${currency} ${totalExpenses.toFixed(2)}\nProfit: ${currency} ${profit.toFixed(2)}`;
                    if (userProfileData.goalProgress) {
                        reply += `\nGoal Progress: ${currency} ${userProfileData.goalProgress.current.toFixed(2)} / ${userProfileData.goalProgress.target.toFixed(2)} (${((userProfileData.goalProgress.current / userProfileData.goalProgress.target) * 100).toFixed(1)}%)`;
                    }
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                } catch (error) {
                    console.error("[ERROR] Stats failed:", error.message);
                    return res.send(`<Response><Message>⚠️ Couldn’t fetch stats. Try again.</Message></Response>`);
                }
            }
    
                // 9. Delete Function for Revenue, Expense, Job, Bill (Owner Only)
                else if (input && (input.toLowerCase().includes("delete") || input.toLowerCase().includes("remove"))) {
                    if (!isOwner) {
                        return res.send(`<Response><Message>⚠️ Only the owner can delete entries.</Message></Response>`);
                    }
                    console.log("[DEBUG] Detected delete request:", input);

                    const auth = await getAuthorizedClient();
                    const sheets = google.sheets({ version: 'v4', auth });

                    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                    const gptResponse = await openaiClient.chat.completions.create({
                        model: "gpt-3.5-turbo",
                        messages: [
                            { role: "system", content: `Parse a delete request: "${input}". Return JSON: { type: 'revenue|expense|job|bill', criteria: { item: 'string|null', amount: 'string|null', date: 'string|null', store: 'string|null', source: 'string|null', billName: 'string|null', jobName: 'string|null' } }. Set unmatched fields to null.` },
                            { role: "user", content: input }
                        ],
                        max_tokens: 150,
                        temperature: 0.3
                    });
                    const deleteRequest = JSON.parse(gptResponse.choices[0].message.content);
                    console.log("[DEBUG] Delete request parsed:", deleteRequest);

                    let sheetName, range, data;
                    if (deleteRequest.type === 'revenue') {
                        sheetName = 'Revenue';
                        range = 'Revenue!A:F';
                    } else {
                        sheetName = 'Sheet1';
                        range = 'Sheet1!A:I';
                    }

                    try {
                        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
                        data = (response.data.values || []).slice(1);
                    } catch (error) {
                        console.error("[ERROR] Failed to fetch data for deletion:", error);
                        return res.send(`<Response><Message>⚠️ Could not retrieve your data. Please try again later.</Message></Response>`);
                    }

                    const matches = data.map((row, index) => ({ row, index })).filter(({ row }) => {
                        if (deleteRequest.type === 'revenue' && row[5] !== 'revenue') return false;
                        if (deleteRequest.type === 'expense' && row[5] !== 'expense') return false;
                        if (deleteRequest.type === 'bill' && row[5] !== 'bill') return false;
                        if (deleteRequest.type === 'job' && row[4] !== deleteRequest.criteria.jobName) return false;

                        const [date, itemOrDesc, amount, storeOrSource, , type] = row;
                        return (
                            (!deleteRequest.criteria.item || itemOrDesc.toLowerCase().includes(deleteRequest.criteria.item?.toLowerCase())) &&
                            (!deleteRequest.criteria.amount || amount.toLowerCase().includes(deleteRequest.criteria.amount?.toLowerCase())) &&
                            (!deleteRequest.criteria.date || date.toLowerCase().includes(deleteRequest.criteria.date?.toLowerCase())) &&
                            (!deleteRequest.criteria.store || storeOrSource?.toLowerCase().includes(deleteRequest.criteria.store?.toLowerCase())) &&
                            (!deleteRequest.criteria.source || storeOrSource?.toLowerCase().includes(deleteRequest.criteria.source?.toLowerCase())) &&
                            (!deleteRequest.criteria.billName || itemOrDesc.toLowerCase().includes(deleteRequest.criteria.billName?.toLowerCase())) &&
                            (!deleteRequest.criteria.jobName || row[4]?.toLowerCase() === deleteRequest.criteria.jobName?.toLowerCase())
                        );
                    });

                    if (matches.length === 0) {
                        return res.send(`<Response><Message>🤔 No ${deleteRequest.type} entries found matching "${input}". Try providing more details.</Message></Response>`);
                    } else if (matches.length === 1) {
                        const { row, index } = matches[0];
                        const [date, itemOrDesc, amount, storeOrSource] = row;
                        const summary = `${deleteRequest.type === 'expense' ? `${amount} for ${itemOrDesc} from ${storeOrSource}` : deleteRequest.type === 'revenue' ? `${amount} from ${storeOrSource}` : deleteRequest.type === 'bill' ? `${amount} for ${itemOrDesc}` : `job ${deleteRequest.criteria.jobName}`} on ${date}`;
                        await setPendingTransactionState(from, { pendingDelete: { type: deleteRequest.type, rowIndex: index, sheetName } });
                        const sent = await sendTemplateMessage(from, confirmationTemplates.deleteConfirmation, {
                            "1": `Are you sure you want to delete this ${deleteRequest.type}: ${summary}? Reply 'yes' or 'no'.`
                        });
                        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>Are you sure you want to delete this ${deleteRequest.type}: ${summary}? Reply 'yes' or 'no'.</Message></Response>`);
                    } else {
                        reply = `🤔 Found ${matches.length} matching ${deleteRequest.type} entries:\n`;
                        matches.slice(0, 3).forEach(({ row }, i) => {
                            const [date, itemOrDesc, amount, storeOrSource] = row;
                            reply += `${i + 1}. ${date} - ${itemOrDesc} (${amount}) ${storeOrSource ? `from ${storeOrSource}` : ''}\n`;
                        });
                        if (matches.length > 3) reply += `...and ${matches.length - 3} more. Please refine your request.`;
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                }

                // 10. Receipt Finder Feature
                else if (input && (input.toLowerCase().includes("find receipt") || input.toLowerCase().includes("where’s my receipt") || input.toLowerCase().includes("show me the receipt"))) {
                    console.log("[DEBUG] Detected receipt finder request:", input);

                    if (!spreadsheetId) {
                        return res.send(`<Response><Message>⚠️ No spreadsheet found for your team. Please contact the owner.</Message></Response>`);
                    }

                    const auth = await getAuthorizedClient();
                    const sheets = google.sheets({ version: 'v4', auth });
                    const expenseRange = 'Sheet1!A:I';
                    let expenses = [];
                    try {
                        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: expenseRange });
                        expenses = (response.data.values || []).slice(1).filter(row => row[5] === "expense");
                    } catch (error) {
                        console.error("[ERROR] Failed to fetch expense data:", error);
                        return res.send(`<Response><Message>⚠️ Could not retrieve your receipts. Please try again later.</Message></Response>`);
                    }

                    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                    const gptResponse = await openaiClient.chat.completions.create({
                        model: "gpt-3.5-turbo",
                        messages: [
                            { role: "system", content: `Parse a receipt-finding request: "${input}". Return JSON: { item: 'string|null', store: 'string|null', date: 'string|null', amount: 'string|null' }. Set unmatched fields to null.` },
                            { role: "user", content: input }
                        ],
                        max_tokens: 100,
                        temperature: 0.3
                    });
                    const searchCriteria = JSON.parse(gptResponse.choices[0].message.content);
                    console.log("[DEBUG] Search criteria:", searchCriteria);

                    const matches = expenses.filter(row => {
                        const [date, item, amount, store] = row;
                        return (
                            (!searchCriteria.item || item.toLowerCase().includes(searchCriteria.item.toLowerCase())) &&
                            (!searchCriteria.store || store.toLowerCase().includes(searchCriteria.store.toLowerCase())) &&
                            (!searchCriteria.date || date.toLowerCase().includes(searchCriteria.date.toLowerCase())) &&
                            (!searchCriteria.amount || amount.toLowerCase().includes(searchCriteria.amount.toLowerCase()))
                        );
                    });

                    if (matches.length === 0) {
                        return res.send(`<Response><Message>🤔 No receipts found matching "${input}". Try providing more details (e.g., item, store, date).</Message></Response>`);
                    } else if (matches.length === 1) {
                        const [date, item, amount, store, , , , imageUrl, loggedBy] = matches[0];
                        reply = `✅ Found your receipt:\n- Date: ${date}\n- Item: ${item}\n- Amount: ${amount}\n- Store: ${store}\n- Logged By: ${loggedBy}`;
                        if (imageUrl) reply += `\n- Image: ${imageUrl}`;
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    } else {
                        reply = `✅ Found ${matches.length} matching receipts:\n`;
                        matches.slice(0, 3).forEach(([date, item, amount, store, , , , , loggedBy], i) => {
                            reply += `${i + 1}. ${date} - ${item} (${amount}) from ${store} by ${loggedBy}\n`;
                        });
                        if (matches.length > 3) reply += `...and ${matches.length - 3} more. Refine your request for details.`;
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                }

                // 11. Metrics Queries (Owner Only)
                else if (input && (input.toLowerCase().includes("how much") ||
                    input.toLowerCase().includes("profit") ||
                    input.toLowerCase().includes("margin") ||
                    input.toLowerCase().includes("spend") ||
                    input.toLowerCase().includes("spent") ||
                    (input.toLowerCase().includes("how about") && (await getLastQuery(from))?.intent))) {
                    if (!isOwner) {
                        return res.send(`<Response><Message>⚠️ Only the owner can view metrics.</Message></Response>`);
                    }
                    console.log("[DEBUG] Detected a metrics query:", input);
                    const activeJob = await getActiveJob(ownerId) || "Uncategorized";

                    const auth = await getAuthorizedClient();
                    const sheets = google.sheets({ version: 'v4', auth });
                    const expenseRange = 'Sheet1!A:I';
                    const revenueRange = 'Revenue!A:F';

                    let expenses = [], revenues = [], bills = [];
                    try {
                        const expenseResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: expenseRange });
                        const allRows = expenseResponse.data.values || [];
                        expenses = allRows.slice(1).filter(row => row[5] === "expense");
                        bills = allRows.slice(1).filter(row => row[5] === "bill");

                        const revenueResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: revenueRange });
                        revenues = (revenueResponse.data.values || []).slice(1);
                    } catch (error) {
                        console.error("[ERROR] Failed to fetch data:", error);
                        return res.send(`<Response><Message>⚠️ Could not retrieve your data. Please try again later.</Message></Response>`);
                    }

                    const parseAmount = (amountStr) => parseFloat(amountStr.replace(/[^0-9.-]/g, '')) || 0;
                    const now = new Date();

                    if (input.toLowerCase().includes("profit") && input.toLowerCase().includes("job")) {
                        const jobName = input.match(/job\s+([\w\s]+)/i)?.[1]?.trim() || activeJob;
                        const jobExpenses = expenses.filter(row => row[4] === jobName);
                        const jobRevenues = revenues.filter(row => row[1] === jobName || row[3] === jobName);
                        const totalExpenses = jobExpenses.reduce((sum, row) => sum + parseAmount(row[2]), 0);
                        const totalRevenue = jobRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
                        const profit = totalRevenue - totalExpenses;
                        await setLastQuery(from, { intent: "profit", timestamp: new Date().toISOString() });
                        return res.send(`<Response><Message>Your profit on Job ${jobName} is $${profit.toFixed(2)} (Revenue: $${totalRevenue.toFixed(2)}, Expenses: $${Math.abs(totalExpenses).toFixed(2)}).</Message></Response>`);
                    }

                    try {
                        const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                        const gptResponse = await openaiClient.chat.completions.create({
                            model: "gpt-3.5-turbo",
                            messages: [
                                { role: "system", content: `Interpret financial query: "${input}". Return JSON: { intent: 'profit|spend|revenue|margin|help|unknown', job: 'name or null', period: 'ytd|month|specific month|null', response: 'text' }. If unclear, suggest a correction in 'response'.` },
                                { role: "user", content: input }
                            ],
                            max_tokens: 150,
                            temperature: 0.3
                        });
                        const aiResult = JSON.parse(gptResponse.choices[0].message.content);
                        if (aiResult.intent === "unknown") {
                            const corrections = await correctErrorsWithAI(`Unclear query: "${input}"`);
                            if (corrections && corrections.intent) {
                                return res.send(`<Response><Message>🤔 Did you mean: "${corrections.intent} on ${corrections.job || 'job'} ${corrections.period || ''}"? Reply with corrected query.</Message></Response>`);
                            }
                            return res.send(`<Response><Message>⚠️ I couldn’t understand your request. Try "How much profit on Job 75?"</Message></Response>`);
                        }
                        if (aiResult.intent === "profit" && aiResult.job) {
                            const jobName = aiResult.job;
                            const jobExpenses = expenses.filter(row => row[4] === jobName);
                            const jobRevenues = revenues.filter(row => row[1] === jobName || row[3] === jobName);
                            const totalExpenses = jobExpenses.reduce((sum, row) => sum + parseAmount(row[2]), 0);
                            const totalRevenue = jobRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
                            const profit = totalRevenue - totalExpenses;
                            await setLastQuery(from, { intent: "profit", timestamp: new Date().toISOString() });
                            return res.send(`<Response><Message>${aiResult.response || `Profit for Job ${jobName} is $${profit.toFixed(2)}.`}</Message></Response>`);
                        }
                        return res.send(`<Response><Message>${aiResult.response}</Message></Response>`);
                    } catch (error) {
                        console.error("[ERROR] AI fallback failed:", error.message);
                        return res.send(`<Response><Message>⚠️ I couldn’t process your request...</Message></Response>`);
                    }
                }

                // 12. Media Handling (Expense Logging)
                else if (mediaUrl) {
                    console.log("[DEBUG] Checking media in message...");
                    let combinedText = "";

                    if (mediaType && mediaType.includes("audio")) {
                        const audioResponse = await axios.get(mediaUrl, { responseType: 'arraybuffer', auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN } });
                        const audioBuffer = Buffer.from(audioResponse.data, 'binary');
                        combinedText = await transcribeAudio(audioBuffer) || "";
                    } else if (mediaType && mediaType.includes("image")) {
                        console.log(`[DEBUG] Processing image from ${mediaUrl}`);
                        combinedText = await processDocumentAI(Buffer.from((await axios.get(mediaUrl, { responseType: 'arraybuffer' })).data)) || "";
                    }

                    if (combinedText) {
                        const defaultData = { date: new Date().toISOString().split('T')[0], item: "Unknown", amount: "$0.00", store: "Unknown Store" };
                        const { data, reply, confirmed } = await handleInputWithAI(from, combinedText, 'expense', parseExpenseMessage, defaultData);

                        if (reply) return res.send(`<Response><Message>${reply}</Message></Response>`);
                        if (data && data.item && data.amount && data.amount !== "$0.00" && data.store) {
                            const category = await categorizeEntry('expense', data, ownerProfile);
                            data.suggestedCategory = category;
                            if (confirmed) {
                                await appendToUserSpreadsheet(ownerId, [data.date, data.item, data.amount, data.store, activeJob, 'expense', category, mediaUrl || '', userName]);
                                reply = `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} on ${data.date} by ${userName} (Category: ${category})`;
                                return res.send(`<Response><Message>${reply}</Message></Response>`);
                            } else {
                                await setPendingTransactionState(from, { pendingExpense: data });
                                const sent = await sendTemplateMessage(from, confirmationTemplates.expense, {
                                    "1": `Expense of ${data.amount} for ${data.item} from ${data.store} on ${data.date} (Category: ${category})`
                                });
                                return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>⚠️ Failed to send confirmation.</Message></Response>`);
                            }
                        }
                        return res.send(`<Response><Message>🤔 Couldn’t parse a valid expense from the media. Please try again.</Message></Response>`);
                    } else {
                        return res.send(`<Response><Message>⚠️ No media detected or unable to extract information.</Message></Response>`);
                    }
                }

                // 13. Additional Commands
else if (input) {
    console.log(`[DEBUG] Checking additional commands for ${from}: "${input}"`);
    const lcInput = input.toLowerCase();
    if (lcInput === 'chief!!') {
        reply = '🔥 You’re the boss, Chief! What’s the next move?';
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (chief command)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else if (lcInput.startsWith('stats')) {
        const expenses = await fetchExpenseData(ownerId);
        const analytics = await calculateExpenseAnalytics(ownerId);
        const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
        reply = `📊 *Financial Stats* (${currency})\nTotal Expenses: ${analytics.total.toFixed(2)}\nTop Category: ${analytics.topCategory || 'None'}\nAvg. Monthly: ${(analytics.total / (analytics.months || 1)).toFixed(2)}`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (stats)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else if (lcInput.startsWith('goal')) {
        if (!userProfileData.goal) {
            reply = "You haven’t set a financial goal yet. Reply with something like 'Grow profit by $10,000' or 'Pay off $5,000 debt'.";
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (no goal)`);
            return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
        const progress = userProfileData.goalProgress?.current || 0;
        const target = userProfileData.goalProgress?.target || 0;
        reply = `🎯 Goal: ${userProfileData.goal}\nProgress: ${currency} ${progress.toFixed(2)} / ${currency} ${target.toFixed(2)} (${((progress / target) * 100).toFixed(1)}%)`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (goal)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else if (lcInput.startsWith('quote')) {
        const quoteData = parseQuoteMessage(input);
        if (!quoteData) {
            reply = "⚠️ Invalid quote format. Try: 'quote [amount] for [description] to [client]'";
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (invalid quote)`);
            return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        const quoteDetails = await buildQuoteDetails(quoteData, ownerProfile);
        const pdfUrl = await generateQuotePDF(ownerId, quoteDetails);
        reply = `📄 Quote generated for ${quoteData.client}: $${quoteData.amount} for ${quoteData.description}\nPDF: ${pdfUrl}`;
        await sendEmail(userProfileData.email, `Quote for ${quoteData.client}`, reply, pdfUrl);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (quote generated)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else if (lcInput.startsWith('start job')) {
        const jobName = input.slice(10).trim();
        if (!jobName) {
            reply = "⚠️ Please provide a job name. Try: 'start job Roof Repair'";
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (invalid job)`);
            return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        await setActiveJob(ownerId, jobName);
        const sent = await sendTemplateMessage(from, confirmationTemplates.startJob, {
            "1": `Job "${jobName}" started. All entries will be tagged with this job until you finish it.`
        });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (job started)`);
        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>⚠️ Failed to send job confirmation.</Message></Response>`);
    } else if (lcInput.startsWith('finish job')) {
        const jobName = input.slice(11).trim();
        if (!jobName) {
            reply = "⚠️ Please provide a job name. Try: 'finish job Roof Repair'";
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (invalid job)`);
            return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        await finishJob(ownerId, jobName);
        reply = `✅ Job "${jobName}" finished.`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (job finished)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
}

// 14. Text Expense Logging
else if (input) {
    console.log(`[DEBUG] Processing text input for ${from}: "${input}"`);
    if (isOnboardingTrigger(input)) {
        console.log(`[INFO] Onboarding trigger detected in text input for ${from}: input="${input}"`);
        if (userProfileData.onboarding_in_progress) {
            reply = "Please respond to the current onboarding question or cancel to restart.";
        } else {
            await db.runTransaction(async (transaction) => {
                const userRef = db.collection('users').doc(from);
                transaction.update(userRef, {
                    onboarding_in_progress: true,
                    name: admin.firestore.FieldValue.delete(),
                    country: admin.firestore.FieldValue.delete(),
                    province: admin.firestore.FieldValue.delete(),
                    email: admin.firestore.FieldValue.delete(),
                    business_province: admin.firestore.FieldValue.delete(),
                    business_country: admin.firestore.FieldValue.delete()
                });
            });
            await db.collection('onboarding').doc(from).delete();
            const newState = {
                step: 0,
                responses: {},
                detectedLocation: {
                    country: userProfileData?.country || "Unknown Country",
                    province: userProfileData?.province || "Unknown Province"
                }
            };
            await setOnboardingState(from, newState);
            reply = "Welcome! What's your name?";
        }
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding restart)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    let state = await getOnboardingState(from);
    const activeJob = await getActiveJob(ownerId) || "Uncategorized";
    const defaultData = {
        date: new Date().toISOString().split('T')[0],
        item: "Unknown",
        amount: "$0.00",
        store: "Unknown Store"
    };
    const parseFn = parseExpenseMessage;
    if (!userProfileData.industry && input.includes('$') && !state?.dynamicStep) {
        await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'industry' });
        reply = "Hey, what industry are you in? (e.g., Construction, Freelancer)";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (industry onboarding)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (state?.dynamicStep === 'industry') {
        userProfileData.industry = input;
        await saveUserProfile(userProfileData);
        reply = `Got it, ${userProfileData.name}! Industry set to ${input}. Keep logging—next up, I’ll ask your financial goal when you add a bill or revenue.`;
        await deleteOnboardingState(from);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (industry set)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (!userProfileData.goal && (input.toLowerCase().includes('bill') || type === 'revenue') && !state?.dynamicStep) {
        await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'goal' });
        reply = "What’s your financial goal, boss? (e.g., Grow profit by $10,000, Pay off $5,000 debt)";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (goal onboarding)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (state?.dynamicStep === 'goal') {
        userProfileData.goal = input;
        if (!input.match(/\d+/) || (!input.includes('profit') && !input.includes('debt'))) {
            reply = "⚠️ That doesn’t look like a goal. Try 'Grow profit by $10,000' or 'Pay off $5,000 debt'.";
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (invalid goal)`);
            return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        userProfileData.goalProgress = {
            target: input.includes('debt')
                ? -parseFloat(input.match(/\d+/)?.[0] || 5000) * 1000
                : parseFloat(input.match(/\d+/)?.[0] || 10000) * 1000,
            current: 0
        };
        await saveUserProfile(userProfileData);
        const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
        reply = `Goal locked in: "${input}" (${currency} ${userProfileData.goalProgress.target.toFixed(2)}). You’re unstoppable, ${userProfileData.name}!`;
        await deleteOnboardingState(from);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (goal set)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    try {
        const { data, reply: aiReply, confirmed } = await handleInputWithAI(from, input, type, parseFn, defaultData);
        if (aiReply) {
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (AI reply)`);
            return res.send(`<Response><Message>${aiReply}</Message></Response>`);
        }
        if (data && data.amount && data.amount !== "$0.00") {
            const errors = detectErrors(data, type);
            const category = await categorizeEntry(type, data, ownerProfile);
            data.suggestedCategory = category;
            if (errors) {
                const corrections = await correctErrorsWithAI(errors);
                if (corrections) {
                    await setPendingTransactionState(from, {
                        pendingExpense: data,
                        pendingCorrection: true,
                        suggestedCorrections: corrections,
                        type
                    });
                    const correctionText = Object.entries(corrections).map(([k, v]) => `${k}: ${data[k] || 'missing'} → ${v}`).join('\n');
                    reply = `🤔 Issues detected:\n${correctionText}\nReply 'yes' to accept or 'no' to edit.\nSuggested Category: ${category}`;
                    await db.collection('locks').doc(lockKey).delete();
                    console.log(`[LOCK] Released lock for ${from} (expense correction)`);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
            }
            if (confirmed) {
                await appendToUserSpreadsheet(ownerId, [data.date, data.item, data.amount, data.store, activeJob, 'expense', category, mediaUrl || '', userName]);
                reply = `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} on ${data.date} by ${userName} (Category: ${category})`;
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (expense logged)`);
                return res.send(`<Response><Message>${reply}</Message></Response>`);
            } else {
                await setPendingTransactionState(from, { pendingExpense: { ...data, suggestedCategory: category }, type });
                const sent = await sendTemplateMessage(from, confirmationTemplates.expense, {
                    "1": `Please confirm: ${data.amount} for ${data.item} from ${data.store} on ${data.date} (Category: ${category})`
                });
                await db.collection('locks').doc(lockKey).delete();
                console.log(`[LOCK] Released lock for ${from} (expense confirmation)`);
                return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>⚠️ Failed to send expense confirmation.</Message></Response>`);
            }
        } else {
            reply = `🤔 Couldn’t parse a valid ${type} from "${input}". Try "expense $100 tools from Home Depot" or "help" for options.`;
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (invalid expense)`);
            return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
    } catch (error) {
        console.error(`[ERROR] ${type} parsing failed:`, error.message);
        reply = `⚠️ Failed to process ${type}: "${input}". Please try again or use a different format.`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (expense parsing error)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
}
        }

// Tax Rate Command
if (body?.toLowerCase().includes("tax rate")) {
    const taxRate = getTaxRate(userProfileData.country, userProfileData.province);
    reply = `Your tax rate is ${(taxRate * 100).toFixed(2)}%${taxRate === 0 ? ' (No sales tax)' : ''}.`;
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (tax rate)`);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
}

// Tax Export Command
if (body?.toLowerCase().startsWith("export tax")) {
    const sheets = google.sheets({ version: 'v4', auth: await getAuthorizedClient() });
    const spreadsheetId = ownerProfile.spreadsheetId;
    const expenses = await fetchExpenseData(ownerId);
    const revenues = (await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Revenue!A:I' })).data.values.slice(1);
    const taxRate = getTaxRate(userProfileData.country, userProfileData.province);
    const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
    const revenueData = revenues.map(r => {
        const amount = parseFloat(r[2].replace(/[^0-9.]/g, ''));
        return [r[0], r[1], `${currency} ${amount.toFixed(2)}`, `Revenue (Tax: ${currency} ${(amount * taxRate).toFixed(2)})`, r[8]];
    });
    const expenseDataPromises = expenses.filter(e => e[5] === 'expense' || e[5] === 'bill').map(async e => [
        e[0], e[1], e[2], await suggestDeductions(ownerId, { description: e[1], category: e[6] }), e[8]
    ]);
    const expenseData = await Promise.all(expenseDataPromises);
    const taxData = [...revenueData, ...expenseData];
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'TaxExport!A:E',
        valueInputOption: 'RAW',
        resource: { values: [['Date', 'Item', 'Amount', 'Category', 'Logged By'], ...taxData] }
    });
    const totalTaxCollected = revenues.reduce((sum, r) => sum + parseFloat(r[2].replace(/[^0-9.]/g, '')) * taxRate, 0);
    reply = `✅ Tax export ready in 'TaxExport'. ${taxData.length} entries, ${currency} ${totalTaxCollected.toFixed(2)} tax collected.`;
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (tax export)`);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
}


// Final fallback
reply = `⚠️ Command not recognized. Try "help" for options.`;
await db.collection('locks').doc(lockKey).delete();
console.log(`[LOCK] Released lock for ${from} (unrecognized command)`);
return res.send(`<Response><Message>${reply}</Message></Response>`);

} catch (error) {
console.error(`[ERROR] Webhook processing failed for ${from}:`, error.message);
const reply = `⚠️ An error occurred. Please try again later.`;
await db.collection('locks').doc(lockKey).delete();
console.log(`[LOCK] Released lock for ${from} (error)`);
return res.send(`<Response><Message>${reply}</Message></Response>`);
}
});
// PWA Parse Endpoint
app.post('/parse', async (req, res) => {
    const { input, type = 'expense' } = req.body;
    if (!input) return res.status(400).json({ error: "Missing input" });



    const parseFn = type === 'expense' ? parseExpenseMessage : parseRevenueMessage;
    const defaultData = type === 'expense'
        ? { date: new Date().toISOString().split('T')[0], item: "Unknown", amount: "$0.00", store: "Unknown Store" }
        : { date: new Date().toISOString().split('T')[0], description: "Payment", amount: "$0.00", client: "Unknown Client" };

    try {
        const { data, reply, confirmed } = await handleInputWithAI('pwa-user', input, type, parseFn, defaultData);
        res.json({ data, reply, confirmed });
    } catch (error) {
        console.error("[ERROR] Parse endpoint failed:", error.message);
        res.status(500).json({ error: "Parsing failed" });
    }
});
// Deep Dive Endpoint
const DEEP_DIVE_TIERS = {
    BASIC: { price: 49, name: "Basic Report", features: ["historical"] },
    FULL: { price: 99, name: "Full Deep Dive", features: ["historical", "forecast_1yr"] },
    ENTERPRISE: { price: 199, name: "Enterprise Custom", features: ["historical", "forecast_10yr", "goals"] }
};

app.post('/deep-dive', async (req, res) => {
    const { userId, tier = 'BASIC', file } = req.body; // Assume file is base64-encoded
    if (!userId || !DEEP_DIVE_TIERS[tier]) {
        return res.status(400).json({ error: "Invalid userId or tier" });
    }

    try {
        let financialData = [];
        const userProfile = await getUserProfile(userId);
        const ownerId = userProfile.ownerId || userId;

        // Pull WhatsApp data if subscribed
        if (userProfile.spreadsheetId) {
            const auth = await getAuthorizedClient();
            const sheets = google.sheets({ version: 'v4', auth });
            const [expenseResponse, revenueResponse] = await Promise.all([
                sheets.spreadsheets.values.get({ spreadsheetId: userProfile.spreadsheetId, range: 'Sheet1!A:I' }),
                sheets.spreadsheets.values.get({ spreadsheetId: userProfile.spreadsheetId, range: 'Revenue!A:I' })
            ]);
            financialData = [
                ...(expenseResponse.data.values || []).slice(1).map(row => ({
                    date: row[0], amount: row[2].replace('$', ''), description: row[1], source: row[3], type: row[5]
                })),
                ...(revenueResponse.data.values || []).slice(1).map(row => ({
                    date: row[0], amount: row[2].replace('$', ''), description: row[1], source: row[3], type: row[5]
                }))
            ];
        }

        // Process uploaded file
        if (file) {
            const fileBuffer = Buffer.from(file, 'base64');
            const fileType = req.headers['content-type'] || 'text/csv';
            const uploadedData = parseFinancialFile(fileBuffer, fileType);
            financialData = financialData.length ? [...financialData, ...uploadedData] : uploadedData;
        }

        if (!financialData.length) {
            return res.status(400).json({ error: "No financial data provided" });
        }

        // Categorize entries
        for (let entry of financialData) {
            entry.category = await categorizeEntry(entry.type, entry, userProfile);
        }

        // Generate report
        const pdfUrl = await generateDeepDiveReport(userId, financialData, DEEP_DIVE_TIERS[tier]);

        // Trigger 30-day trial if not subscribed
        if (!userProfile.subscriptionTier) {
            await db.collection('users').doc(userId).update({
                subscriptionTier: 'Pro',
                trialStart: new Date().toISOString(),
                trialEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                tokenUsage: { messages: 0, aiCalls: 0 }
            });
            await updateUserTokenUsage(userId, { messages: 1, aiCalls: 1 }); // For report generation
            await sendTemplateMessage(userId, "HXwelcome_trial", [
                { type: "text", text: userProfile.name || "User" },
                { type: "text", text: "30-day trial activated! Start logging expenses via WhatsApp." }
            ]);
        } else {
            await updateUserTokenUsage(userId, { messages: 1, aiCalls: 1 }); // Track report generation
        }

        res.json({ reportUrl: pdfUrl, message: "Deep Dive report generated successfully" });
    } catch (error) {
        console.error("[ERROR] Deep Dive processing failed:", error.message);
        res.status(500).json({ error: "Failed to generate report" });
    }
});
// ─── Helper Functions for Bill Management ─────────────────────────────


// GET Route for Server Verification
app.get('/', (req, res) => {
    console.log("[DEBUG] GET request received at root URL.");
    res.send("Webhook server is up and running!");
});

// Start Express Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`[DEBUG] Webhook server running at http://localhost:${PORT}`);
});

// Debugging environment variables and initializing Google Vision credentials
console.log("[DEBUG] Checking environment variables...");
console.log("[DEBUG] GOOGLE_CREDENTIALS_BASE64:", process.env.GOOGLE_CREDENTIALS_BASE64 ? "Loaded" : "Missing");
console.log("[DEBUG] FIREBASE_CREDENTIALS_BASE64:", process.env.FIREBASE_CREDENTIALS_BASE64 ? "Loaded" : "Missing");
console.log("[DEBUG] OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "Loaded" : "Missing");

const googleVisionBase64 = process.env.GOOGLE_VISION_CREDENTIALS_BASE64 || process.env.GOOGLE_CREDENTIALS_BASE64;
if (!googleVisionBase64) {
    throw new Error("[ERROR] Missing Google Vision API credentials. Ensure GOOGLE_CREDENTIALS_BASE64 is set.");
}
const visionCredentialsPath = "/tmp/google-vision-key.json";
fs.writeFileSync(visionCredentialsPath, Buffer.from(googleVisionBase64, 'base64'));
process.env.GOOGLE_APPLICATION_CREDENTIALS = visionCredentialsPath;
console.log("[DEBUG] Google Vision Application Credentials set successfully.");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
const environment = process.env.NODE_ENV || 'development';
console.log(`[DEBUG] Environment: ${environment}`);

module.exports = app;