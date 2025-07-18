const { createUserProfile, saveUserProfile, generateOTP, getUserProfile } = require('../services/postgres');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../utils/stateManager');
const { sendTemplateMessage, sendMessage } = require('../services/twilio');
const { confirmationTemplates } = require('../config');
const { getValidationLists, detectLocation } = require('../utils/validateLocation');
const { handleInputWithAI, handleError } = require('../utils/aiErrorHandler');

async function handleOnboarding(from, input, userProfile, ownerId) {
  try {
    let state = await getPendingTransactionState(from) || { step: userProfile.onboarding_step || 0, responses: {}, detectedLocation: detectLocation(from), invalidAttempts: {} };
    const msg = input?.trim().toLowerCase() || '';

    console.log(`[DEBUG] Onboarding state for ${from}: step=${state.step}, response=${msg}`);

    // Step 0: Start onboarding
    if (state.step === 0 || msg === 'start onboarding') {
      if (userProfile?.onboarding_completed) {
        return `<Response><Message>You've already completed onboarding. Reply 'help' for commands.</Message></Response>`;
      }
      userProfile = await createUserProfile({ user_id: from, ownerId: from, onboarding_in_progress: true });
      state.step = 1;
      await setPendingTransactionState(from, state);
      return `<Response><Message>Welcome to Chief AI! Please reply with your full name.</Message></Response>`;
    }

    // Step 1: Capture name (simple validation, no AI)
    if (state.step === 1) {
      const name = input.trim();
      if (!name || name.length < 2) {
        return `<Response><Message>Please provide your full name to continue.</Message></Response>`;
      }
      state.responses.name = name;
      state.step = 2;
      await setPendingTransactionState(from, state);
      return await sendTemplateMessage(from, confirmationTemplates.locationConfirmation, [
        { type: 'text', text: state.detectedLocation.province },
        { type: 'text', text: state.detectedLocation.country }
      ]);
    }

    // Step 2: Confirm location
    if (state.step === 2) {
      if (msg === 'yes') {
        state.responses.location = state.detectedLocation;
        state.step = 3;
        await setPendingTransactionState(from, state);
        return await sendTemplateMessage(from, confirmationTemplates.businessLocationConfirmation, []);
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

    // Step 2.5: Manual location edit
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
        if (!isValidProvince || !isValidCountry) {
          return null;
        }
        return { province, country };
      };
      const { data, reply, confirmed } = await handleInputWithAI(from, input, 'location', parseFn, defaultData);
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
      state.invalidAttempts.location = 0; // Reset on success
      state.step = 3;
      await setPendingTransactionState(from, state);
      return await sendTemplateMessage(from, confirmationTemplates.businessLocationConfirmation, []);
    }

    // Step 3: Confirm business location
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

    // Step 3.5: Manual business location edit
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
        if (!isValidProvince || !isValidCountry) {
          return null;
        }
        return { province, country };
      };
      const { data, reply, confirmed } = await handleInputWithAI(from, input, 'business_location', parseFn, defaultData);
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
      state.invalidAttempts.business_location = 0; // Reset on success
      state.step = 4;
      await setPendingTransactionState(from, state);
      return `<Response><Message>Please share your email address for your financial dashboard.</Message></Response>`;
    }

    // Step 4: Collect email (simple validation, no AI)
    if (state.step === 4) {
      const email = input.trim();
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
      state.invalidAttempts.email = 0; // Reset on success
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
      userProfile = await getUserProfile(from);
      const otp = await generateOTP(from);
      const dashboardUrl = `https://chief-ai-refactored.vercel.app/dashboard/${from}?token=${userProfile.dashboard_token}`;
      await sendTemplateMessage(from, confirmationTemplates.spreadsheetLink, [
        { type: 'text', text: dashboardUrl }
      ]);
      const name = userProfile.name || 'there';
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

    // Step 5: Collect industry (simple validation, no AI)
    if (state.step === 5) {
      const industry = input.trim();
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
      state.invalidAttempts.industry = 0; // Reset on success
      await saveUserProfile({ ...userProfile, user_id: from });
      state.step = 6;
      await setPendingTransactionState(from, state);
      return `<Response><Message>Please set a financial goal (e.g., 'Grow profit by $10000' or 'Pay off $5000 debt').</Message></Response>`;
    }

    // Step 6: Collect goal (keep AI for parsing, as goals have specific format)
    if (state.step === 6) {
      const defaultData = { goal: '' };
      const { data, reply, confirmed } = await handleInputWithAI(from, input, 'goal', input => ({ goal: input.trim() }), defaultData);
      if (!confirmed || !data.goal.match(/\d+/) || (!data.goal.includes('profit') && !data.goal.includes('debt'))) {
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
        target: data.goal.includes('debt')
          ? -parseFloat(data.goal.match(/\d+/)?.[0] || 5000) * 1000
          : parseFloat(data.goal.match(/\d+/)?.[0] || 10000) * 1000,
        current: 0
      };
      state.invalidAttempts.goal = 0; // Reset on success
      await saveUserProfile({ ...userProfile, onboarding_in_progress: false, onboarding_completed: true });
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
      await deletePendingTransactionState(from);
      return `<Response><Message>✅ Goal set: "${data.goal}" (${currency} ${userProfile.goal_progress.target.toFixed(2)}). You're ready to go!</Message></Response>`;
    }

    // Fallback
    return `<Response><Message>Unknown onboarding state. Reply 'start onboarding' to begin again.</Message></Response>`;
  } catch (error) {
    console.error('[ERROR] handleOnboarding failed for', from, ':', error.message);
    return await handleError(from, error, 'handleOnboarding', input);
  }
}

module.exports = { handleOnboarding };