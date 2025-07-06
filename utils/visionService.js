const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

// ✅ Document AI Configuration
const PROJECT_ID = process.env.GCP_PROJECT_ID;  // Your actual project ID
const LOCATION = (process.env.GCP_LOCATION || "us").toLowerCase();  
const PROCESSOR_ID = process.env.DOCUMENTAI_PROCESSOR_ID;  // Your Document AI processor ID

if (!process.env.GOOGLE_VISION_CREDENTIALS_BASE64) {
    throw new Error("[ERROR] GOOGLE_VISION_CREDENTIALS_BASE64 is missing. Cannot authenticate Google Vision API.");
}
console.log("[DEBUG] Loading Google Vision API credentials from environment variable.");
const googleVisionCredentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_VISION_CREDENTIALS_BASE64, 'base64').toString('utf-8')
);

// Create a GoogleAuth client for Vision API
const authClient = new GoogleAuth({
    credentials: googleVisionCredentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

/**
 * Process receipt image with Google Document AI (Receipts Processor).
 *
 * @param {string} imageSource - URL of the receipt image.
 * @returns {Promise<Object|null>} Parsed receipt data including full text or null if failed.
 */
async function extractTextFromImage(imageSource) {
    try {
        console.log(`[DEBUG] Downloading image from: ${imageSource}`);

        // Download the image using Twilio credentials.
        const response = await axios.get(imageSource, {
            responseType: 'arraybuffer',
            auth: {
                username: process.env.TWILIO_ACCOUNT_SID,
                password: process.env.TWILIO_AUTH_TOKEN,
            },
        });

        console.log("[DEBUG] Image downloaded successfully. Sending to Google Document AI...");

        const endpoint = `https://${LOCATION}-documentai.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/processors/${PROCESSOR_ID}:process`;

        const requestPayload = {
            rawDocument: {
                content: Buffer.from(response.data).toString('base64'),
                mimeType: "image/jpeg",
            },
        };

        const accessTokenResponse = await authClient.getAccessToken();
        const accessToken = accessTokenResponse.token || accessTokenResponse;
        const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
        };

        const { data } = await axios.post(endpoint, requestPayload, { headers });

        console.log("[DEBUG] Document AI Response:", JSON.stringify(data, null, 2));

        if (!data.document) {
            console.log("[DEBUG] No document data found in Document AI response.");
            return null;
        }

        const fields = data.document.entities || [];
        let store = fields.find(f => f.type === "store_name" || f.type === "merchant_name")?.mentionText || "Unknown Store";
        let date = fields.find(f => f.type === "date")?.mentionText || new Date().toISOString().split('T')[0];
        let total = fields.find(f => f.type === "total_amount")?.mentionText || "Unknown Amount";

        // Fallback for store name recognition
        if (store === "Unknown Store") {
            const commonStores = ["Canadian Tire", "Loblaws", "Walmart"];
            store = commonStores.find(name => data.document.text.toLowerCase().includes(name.toLowerCase())) || store;
        }

        // Fallback for date recognition
        if (date === new Date().toISOString().split('T')[0]) {
            const dateMatch = data.document.text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
            if (dateMatch) date = dateMatch[0];
        }

        console.log(`[DEBUG] Parsed Receipt - Store: ${store}, Date: ${date}, Amount: ${total}`);

        // Include the full OCR text in the return value
        return {
            store,
            date,
            amount: total,
            text: data.document.text || "" // Ensure full text is included
        };
    } catch (error) {
        console.error("[ERROR] Document AI Failed:", error.message);
        return {
            store: "Unknown Store",
            date: new Date().toISOString().split('T')[0],
            amount: "Unknown Amount",
            text: "",
            error: "Failed to process document"
        };
    }
}

module.exports = { extractTextFromImage };