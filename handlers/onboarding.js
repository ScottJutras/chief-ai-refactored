const { createUserProfile, saveUserProfile, generateOTP, getUserProfile } = require('../services/postgres');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState, clearUserState } = require('../utils/stateManager');
const { sendTemplateMessage, sendMessage } = require('../services/twilio');
const { confirmationTemplates } = require('../config');
const { getValidationLists, detectLocation } = require('../utils/validateLocation');
const { handleInputWithAI, handleError } = require('../utils/aiErrorHandler');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function handleOnboarding(from, input, userProfile, ownerId) {
  try {
    const msgRaw = input || '';
    const msg = msgRaw.trim().toLowerCase();
    const wantsReset = msg === 'reset onboarding' || msg === 'start onboarding';

    // If user profile doesn't exist (e.g., you deleted the user row) OR user explicitly wants to restart,
    // wipe any lingering state and start from step 1.
    if (!userProfile || wantsReset) {
      await clearUserState(from).catch(() => {}); // ignore if locks table doesn't exist
      const state = { step: 1, responses: {}, detectedLocation: detectLocation(from), invalidAttempts: {} };
      // (Re)create the profile shell so downstream logic has a record
      const profile = userProfile || await createUserProfile({ user_id: from, ownerId: from, onboarding_in_progress: true });
      await setPendingTransactionState(from, state);
      return `<Response><Message>Welcome to Chief AI! Please reply with your full name.</Message></Response>`;
    }

    // If we’re here, userProfile exists. Pull any saved state (may be null).
    let state = await getPendingTransactionState(from);
    // If no state exists, initialize a fresh one (do NOT rely on onboarding_step—it's not persisted).
    if (!state) {
      state = { step: 1, responses: {}, detectedLocation: detectLocation(from), invalidAttempts: {} };
      await setPendingTransactionState(from, state);
      return `<Response><Message>Welcome to Chief AI! Please reply with your full name.</Message></Response>`;
    }

    console.log(`[DEBUG] Onboarding state for ${from}: step=${state.step}, msg=${msg}`);

    // ---- Step 1: capture full name
    if (state.step === 1) {
      const name = msgRaw.trim();
      if (!name || name.length < 2) {
        return `<Response><Message>Please provide your full name to continue.</Message></Response>`;
      }
      state.responses.name = name;
      state.step = 2;
      await setPendingTransactionState(from, state);

      // SEND QUICK REPLY TEMPLATE (strings, not objects) + return empty TwiML
      await sendTemplateMessage(
        from,
        confirmationTemplates.locationConfirmation, // HX content SID
        [ state.detectedLocation.province, state.detectedLocation.country ]
      );
      return `<Response></Response>`;
    }

    // ---- Step 2: confirm detected location
    if (state.step === 2) {
      if (msg === 'yes') {
        state.responses.location = state.detectedLocation;
        state.step = 3;
        await setPendingTransactionState(from, state);
        await sendTemplateMessage(from, confirmationTemplates.businessLocationConfirmation, []);
        return `<Response></Response>`;
      } else if (msg === 'edit') {
        state.step = 2.5;
        await setPendingTransactionState(from, state);
        return `<Response><Message>Please provide your State/Province, Country (e.g., 'Ontario, Canada').</Message></Response>`;
      } else if (msg === 'cancel') {
        await deletePendingTransactionState(from);
        await saveUserProfile({ ...userProfile, onboarding_in_progress: false });
        return `<Response><Message>Onboarding cancelled. Reply 'start onboarding' to begin again.</Message></Response>`;
      } else {
        return `<Response><Message>Please reply with 'yes', 'edit', or 'cancel' to confirm your location.</Message></Response>`;
      }
    }

    // ---- Step 2.5: manual personal location
    if (state.step === 2.5) {
      const { knownProvinces, knownCountries } = getValidationLists();
      const countryAliases = { 'united states': 'United States', 'us': 'United States', 'canada': 'Canada' };
      const defaultData = { province: '', country: '' };
      const parseFn = input => {
        let province, country;
        const match = input.match(/^(.+?)[\s,]+(.+)$/i);
        if (match) {
          province = match[1].trim();
          country = match[2].trim();
        } else {
          const parts = input.trim().split(/\s+/);
          country = parts.pop();
          province = parts.join(' ').trim();
        }
        country = countryAliases[country.toLowerCase()] || country;
        const isValidProvince = knownProvinces.some(p => p.toLowerCase() === province.toLowerCase());
        const isValidCountry = knownCountries.some(c => c.toLowerCase() === country.toLowerCase());
        if (!isValidProvince || !isValidCountry) return null;
        return { province, country };
      };
      const { data, reply, confirmed } = await handleInputWithAI(from, msgRaw, 'location', parseFn, defaultData);
      if (!confirmed) {
        state.invalidAttempts.location = (state.invalidAttempts.location || 0) + 1;
        if (state.invalidAttempts.location > 3) {
          await deletePendingTransactionState(from);
          await saveUserProfile({ ...userProfile, onboarding_in_progress: false });
          return `<Response><Message>Too many invalid location attempts. Onboarding cancelled.</Message></Response>`;
        }
        await setPendingTransactionState(from, state);
        return `<Response><Message>${reply || "Invalid location. Please use 'State/Province, Country' format (e.g., 'Ontario, Canada')."}</Message></Response>`;
      }
      state.responses.location = data;
      state.invalidAttempts.location = 0;
      state.step = 3;
      await setPendingTransactionState(from, state);
      await sendTemplateMessage(from, confirmationTemplates.businessLocationConfirmation, []);
      return `<Response></Response>`;
    }

    // ---- Step 3: confirm business location equals personal?
    if (state.step === 3) {
      if (msg === 'yes') {
        state.responses.business_location = state.responses.location;
        state.step = 4;
        await setPendingTransactionState(from, state);
        return `<Response><Message>Please share your email address for your financial dashboard.</Message></Response>`;
      } else if (msg === 'no') {
        state.step = 3.5;
        await setPendingTransactionState(from, state);
        return `<Response><Message>Please provide your business's registered State/Province, Country (e.g., 'Ontario, Canada').</Message></Response>`;
      } else if (msg === 'cancel') {
        await deletePendingTransactionState(from);
        await saveUserProfile({ ...userProfile, onboarding_in_progress: false });
        return `<Response><Message>Onboarding cancelled. Reply 'start onboarding' to begin again.</Message></Response>`;
      } else {
        return `<Response><Message>Please reply with 'yes', 'no', or 'cancel' to confirm your business location.</Message></Response>`;
      }
    }

    // ---- Step 3.5: manual business location
    if (state.step === 3.5) {
      const { knownProvinces, knownCountries } = getValidationLists();
      const countryAliases = { 'united states': 'United States', 'us': 'United States', 'canada': 'Canada' };
      const defaultData = { province: '', country: '' };
      const parseFn = input => {
        let province, country;
        const match = input.match(/^(.+?)[\s,]+(.+)$/i);
        if (match) {
          province = match[1].trim();
          country = match[2].trim();
        } else {
          const parts = input.trim().split(/\s+/);
          country = parts.pop();
          province = parts.join(' ').trim();
        }
        country = countryAliases[country.toLowerCase()] || country;
        const isValidProvince = knownProvinces.some(p => p.toLowerCase() === province.toLowerCase());
        const isValidCountry = knownCountries.some(c => c.toLowerCase() === country.toLowerCase());
        if (!isValidProvince || !isValidCountry) return null;
        return { province, country };
      };
      const { data, reply, confirmed } = await handleInputWithAI(from, msgRaw, 'business_location', parseFn, defaultData);
      if (!confirmed) {
        state.invalidAttempts.business_location = (state.invalidAttempts.business_location || 0) + 1;
        if (state.invalidAttempts.business_location > 3) {
          await deletePendingTransactionState(from);
          await saveUserProfile({ ...userProfile, onboarding_in_progress: false });
          return `<Response><Message>Too many invalid location attempts. Onboarding cancelled.</Message></Response>`;
        }
        await setPendingTransactionState(from, state);
        return `<Response><Message>${reply || "Invalid business location. Please use 'State/Province, Country' format (e.g., 'Ontario, Canada')."}</Message></Response>`;
      }
      state.responses.business_location = data;
      state.invalidAttempts.business_location = 0;
      state.step = 4;
      await setPendingTransactionState(from, state);
      return `<Response><Message>Please share your email address for your financial dashboard.</Message></Response>`;
    }

    // ---- Step 4: email
    if (state.step === 4) {
      const email = msgRaw.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        state.invalidAttempts.email = (state.invalidAttempts.email || 0) + 1;
        if (state.invalidAttempts.email > 3) {
          await deletePendingTransactionState(from);
          await saveUserProfile({ ...userProfile, onboarding_in_progress: false });
          return `<Response><Message>Too many invalid attempts. Onboarding cancelled.</Message></Response>`;
        }
        await setPendingTransactionState(from, state);
        return `<Response><Message>Please provide a valid email address for your financial dashboard.</Message></Response>`;
      }

      state.responses.email = email;
      state.invalidAttempts.email = 0;

      const userProfileData = {
        ...userProfile,
        name: state.responses.name,
        country: state.responses.location.country,
        province: state.responses.location.province,
        business_country: state.responses.business_location.country,
        business_province: state.responses.business_location.province,
        email: state.responses.email,
        onboarding_in_progress: true,
        onboarding_completed: false
      };
      await saveUserProfile(userProfileData);

      const freshProfile = await getUserProfile(from);
      await generateOTP(from);

      const dashboardUrl = `https://chief-ai-refactored.vercel.app/dashboard/${from}?token=${freshProfile.dashboard_token}`;

      await sendTemplateMessage(from, confirmationTemplates.spreadsheetLink, [ dashboardUrl ]);

      const name = freshProfile.name || 'there';
      const congratsMessage = `Congratulations ${name}!
You’ve now got a personal CFO — in your pocket — on demand.
Real-time. Data-smart. Built to make your business *make sense*.
📈 We’re talking:
— Auto-tracking your money
— Instant profit breakdowns
— No more “where did it all go?”
— Absolute clarity on every move 💸
Start simple. Try messages like:
🧱 Starting a Job: Start Jack's renovation today
🧾 Logging an Expense: Spent $980 at Home Depot for lumber
🚚 Adding a Monthly Bill: Add monthly truck payment $760
💬 Getting Answers: What do I need to earn this month to pay all of my bills?
⏱ Tracking Hours: Clock in, Break time, Clock out
🛠 Pausing a Job: Pause Jack's renovation to do a repair
✅ Finishing a Job: Finished Jack's renovation
💵 Logging Revenue: Got a $7,500 payment from:J
📊 Getting Metrics: How long did it take to complete Jack's job and how much did I make?
Your financial dashboard is ready! Visit: ${dashboardUrl}
You'll receive a one-time code via WhatsApp to access it.
A quick walkthrough video is on its way.
Let’s build something great.
— Chief 💼`;
      await sendMessage(from, congratsMessage);

      state.step = 5;
      await setPendingTransactionState(from, state);
      return `<Response><Message>Please provide your industry (e.g., Construction, Freelancer).</Message></Response>`;
    }

    // ---- Step 5: industry -> goal options
    if (state.step === 5) {
      const industry = msgRaw.trim();
      if (!industry || industry.length < 3) {
        state.invalidAttempts.industry = (state.invalidAttempts.industry || 0) + 1;
        if (state.invalidAttempts.industry > 3) {
          await deletePendingTransactionState(from);
          await saveUserProfile({ ...userProfile, onboarding_in_progress: false });
          return `<Response><Message>Too many invalid attempts. Onboarding cancelled.</Message></Response>`;
        }
        await setPendingTransactionState(from, state);
        return `<Response><Message>Please provide your industry (e.g., Construction, Freelancer).</Message></Response>`;
      }
      userProfile.industry = industry;
      state.invalidAttempts.industry = 0;
      await saveUserProfile({ ...userProfile, user_id: from });
      state.step = 6;
      await setPendingTransactionState(from, state);

      await sendTemplateMessage(from, confirmationTemplates.goalOptions, []);
      return `<Response></Response>`;
    }

    // ---- Step 6: goal
    if (state.step === 6) {
      const defaultData = { goal: '', amount: 0 };
      const parseFn = input => {
        const match = input.match(/(grow profit by|pay off)\s+\$?(\d+(?:\.\d{1,2})?)/i);
        if (!match) return null;
        const goalType = match[1].toLowerCase();
        const amount = parseFloat(match[2]) * 1000;
        return { goal: `${goalType} $${amount}`, amount };
      };
      const { data, reply, confirmed } = await handleInputWithAI(from, msgRaw, 'goal', parseFn, defaultData);
      if (!confirmed) {
        state.invalidAttempts.goal = (state.invalidAttempts.goal || 0) + 1;
        if (state.invalidAttempts.goal > 3) {
          await deletePendingTransactionState(from);
          await saveUserProfile({ ...userProfile, onboarding_in_progress: false });
          return `<Response><Message>Too many invalid attempts. Onboarding cancelled.</Message></Response>`;
        }
        await setPendingTransactionState(from, state);
        return `<Response><Message>${reply || "Invalid goal. Try 'Grow profit by $10000' or 'Pay off $5000 debt'."}</Message></Response>`;
      }

      userProfile.goal = data.goal;
      userProfile.goal_progress = {
        target: data.goal.includes('debt') ? -data.amount : data.amount,
        current: 0
      };
      state.invalidAttempts.goal = 0;

      await saveUserProfile({ ...userProfile, onboarding_in_progress: false, onboarding_completed: true });
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
      await deletePendingTransactionState(from);

      return `<Response><Message>✅ Goal set: "${data.goal}" (${currency} ${userProfile.goal_progress.target.toFixed(2)}). You're ready to go!</Message></Response>`;
    }

    return `<Response><Message>Unknown onboarding state. Reply 'start onboarding' to begin again.</Message></Response>`;
  } catch (error) {
    console.error('[ERROR] handleOnboarding failed for', from, ':', error.message);
    return await handleError(from, error, 'handleOnboarding', input);
  }
}

module.exports = { handleOnboarding };
