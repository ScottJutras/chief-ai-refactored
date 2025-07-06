// utils/sendGridService.js
const sgMail = require("@sendgrid/mail");

// Load SendGrid API Key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/**
 * Sends an email with a spreadsheet or quote link to the user.
 * @param {string} userEmail - The recipient's email.
 * @param {string} spreadsheetId - The ID of the created Google Spreadsheet or Drive file.
 * @param {string} [subject] - Email subject (defaults to 'Your Expense Tracking Spreadsheet is Ready!').
 */
async function sendSpreadsheetEmail(userEmail, spreadsheetId, subject = 'Your Expense Tracking Spreadsheet is Ready!') {
    if (!userEmail) {
        console.error("[ERROR] No email provided. Cannot send email.");
        return;
    }

    const isQuote = subject.toLowerCase().includes('quote');
    const url = isQuote
        ? `https://drive.google.com/file/d/${spreadsheetId}/view`
        : `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

    const msg = {
        to: userEmail,
        from: "scott@scottjutras.com", // Verified sender
        subject,
        text: isQuote
            ? `Hello,\n\nYour quote has been generated. You can view and download it here: ${url}.\n\nBest,\nSherpAi Team`
            : `Hello,\n\nYour expense tracking spreadsheet has been created. You can access it here: ${url}.\n\nBest,\nSherpAi Team`,
        html: isQuote
            ? `<p>Hello,</p><p>Your quote has been generated.</p><p><strong><a href="${url}" target="_blank">Click here to view and download it</a></strong></p><p>Best,<br>SherpAi Team</p>`
            : `<p>Hello,</p><p>Your expense tracking spreadsheet has been created.</p><p><strong><a href="${url}" target="_blank">Click here to access it</a></strong></p><p>Best,<br>SherpAi Team</p>`,
    };

    try {
        await sgMail.send(msg);
        console.log(`[✅ SUCCESS] ${isQuote ? 'Quote' : 'Spreadsheet'} email sent to ${userEmail}`);
    } catch (error) {
        console.error("[ERROR] SendGrid Email Failed:", error.response?.body || error.message);
    }
}

async function sendEmail({ to, from, subject, text }) {
    const msg = { to, from, subject, text };
    try {
        await sgMail.send(msg);
        console.log('[DEBUG] Email sent successfully:', subject);
    } catch (error) {
        console.error('[ERROR] Failed to send email:', error);
        throw error;
    }
}

module.exports = { 
    sendSpreadsheetEmail,
    sendEmail 
};


