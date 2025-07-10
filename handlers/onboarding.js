const { createUserProfile, saveUserProfile, generateOTP, getUserProfile } = require('../services/postgres');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../utils/stateManager');
const { sendTemplateMessage, sendMessage } = require('../services/twilio');
const { confirmationTemplates } = require('../config');
const { getValidationLists, detectLocation } = require('../utils/validateLocation');
const { releaseLock } = require('../middleware/lock');

async function handleOnboarding(from, input, userProfile, ownerId) {
  const lockKey = `lock:${from}`;
  try {
    let state = await getPendingTransactionState(from) || { step: 0, responses: {}, detectedLocation: detectLocation(from) };
    const msg = input?.trim() || '';

    console.log(`[DEBUG] Onboarding state for ${from}: step=${state.step}, response=${msg}`);

    // Step 0: Start onboarding
    if (state.step === 0 || msg.toLowerCase() === 'start onboarding') {
      if (userProfile?.onboarding_completed) {
        return await sendMessage(from, "You've already completed onboarding. Reply 'help' for commands.");
      }
      await createUserProfile({ user_id: from, ownerId: from, onboarding_in_progress: true });
      userProfile = await getUserProfile(from);
      state.step = 1;
      await setPendingTransactionState(from, state);
      return await sendMessage(from, 'Welcome to Chief AI! Please reply with your full name.');
    }

    // Step 1: Capture name
    if (state.step === 1) {
      if (!msg) {
        return await sendMessage(from, 'Please provide your full name to continue.');
      }
      state.responses.name = msg;
      state.step = 2;
      await setPendingTransactionState(from, state);
      return await sendTemplateMessage(from, confirmationTemplates.locationConfirmation, [
        { type: 'text', text: state.detectedLocation.province },
        { type: 'text', text: state.detectedLocation.country }
      ]);
    }

    // Step 2: Confirm location
    if (state.step === 2) {
      const lc = msg.toLowerCase();
      if (lc === 'yes') {
        state.step = 3;
        state.responses.location = state.detectedLocation;
        await setPendingTransactionState(from, state);
        return await sendTemplateMessage(from, confirmationTemplates.businessLocationConfirmation, []);
      } else if (lc === 'edit') {
        state.step = 2.5;
        await setPendingTransactionState(from, state);
        return await sendMessage(from, "Please provide your State/Province, Country (e.g., 'Ontario, Canada').");
      } else if (lc === 'cancel') {
        await deletePendingTransactionState(from);
        await saveUserProfile({ user_id: from, onboarding_in_progress: false });
        return await sendMessage(from, "Onboarding cancelled. Reply 'start onboarding' to begin again.");
      } else {
        return await sendMessage(from, "Please reply with 'yes', 'edit', or 'cancel' to confirm your location.");
      }
    }

    // Step 2.5: Manual location edit
    if (state.step === 2.5) {
      if (!msg) {
        return await sendMessage(from, "Please provide your State/Province, Country (e.g., 'Ontario, Canada').");
      }
      const { knownProvinces, knownCountries } = getValidationLists();
      const countryAliases = { 'united states': 'United States', 'us': 'United States', 'canada': 'Canada' };
      let province, country;
      const match = msg.match(/^(.+?)[\s,]+(.+)$/);
      if (match) {
        province = match[1].trim();
        country = match[2].trim();
      } else {
        const parts = msg.trim().split(/\s+/);
        country = parts.pop();
        province = parts.join(' ').trim();
      }
      country = countryAliases[country.toLowerCase()] || country;
      const isValidProvince = knownProvinces.some(p => p.toLowerCase() === province.toLowerCase());
      const isValidCountry = knownCountries.some(c => c.toLowerCase() === country.toLowerCase());
      if (!isValidProvince || !isValidCountry) {
        state.invalidLocationAttempts = (state.invalidLocationAttempts || 0) + 1;
        if (state.invalidLocationAttempts > 3) {
          await deletePendingTransactionState(from);
          await saveUserProfile({ user_id: from, onboarding_in_progress: false });
          return await sendMessage(from, "Too many invalid location attempts. Onboarding cancelled.");
        }
        return await sendMessage(from, "Invalid location. Please use 'State/Province, Country' format (e.g., 'Ontario, Canada').");
      }
      state.responses.location = { province, country };
      state.step = 3;
      await setPendingTransactionState(from, state);
      return await sendTemplateMessage(from, confirmationTemplates.businessLocationConfirmation, []);
    }

    // Step 3: Confirm business location
    if (state.step === 3) {
      const lc = msg.toLowerCase();
      if (lc === 'yes') {
        state.step = 4;
        state.responses.business_location = state.responses.location;
        await setPendingTransactionState(from, state);
        return await sendMessage(from, "Please share your email address for your financial dashboard.");
      } else if (lc === 'no') {
        state.step = 3.5;
        await setPendingTransactionState(from, state);
        return await sendMessage(from, "Please provide your business's registered State/Province, Country (e.g., 'Ontario, Canada').");
      } else if (lc === 'cancel') {
        await deletePendingTransactionState(from);
        await saveUserProfile({ user_id: from, onboarding_in_progress: false });
        return await sendMessage(from, "Onboarding cancelled. Reply 'start onboarding' to begin again.");
      } else {
        return await sendMessage(from, "Please reply with 'yes', 'no', or 'cancel' to confirm your business location.");
      }
    }

    // Step 3.5: Manual business location edit
    if (state.step === 3.5) {
      if (!msg) {
        return await sendMessage(from, "Please provide your business's registered State/Province, Country (e.g., 'Ontario, Canada').");
      }
      const { knownProvinces, knownCountries } = getValidationLists();
      const countryAliases = { 'united states': 'United States', 'us': 'United States', 'canada': 'Canada' };
      let businessProvince, businessCountry;
      const match = msg.match(/^(.+?)[\s,]+(.+)$/);
      if (match) {
        businessProvince = match[1].trim();
        businessCountry = match[2].trim();
      } else {
        const parts = msg.trim().split(/\s+/);
        businessCountry = parts.pop();
        businessProvince = parts.join(' ').trim();
      }
      businessCountry = countryAliases[businessCountry.toLowerCase()] || businessCountry;
      const isValidProvince = knownProvinces.some(p => p.toLowerCase() === businessProvince.toLowerCase());
      const isValidCountry = knownCountries.some(c => c.toLowerCase() === businessCountry.toLowerCase());
      if (!isValidProvince || !isValidCountry) {
        state.invalidLocationAttempts = (state.invalidLocationAttempts || 0) + 1;
        if (state.invalidLocationAttempts > 3) {
          await deletePendingTransactionState(from);
          await saveUserProfile({ user_id: from, onboarding_in_progress: false });
          return await sendMessage(from, "Too many invalid location attempts. Onboarding cancelled.");
        }
        return await sendMessage(from, "Invalid business location. Please use 'State/Province, Country' format (e.g., 'Ontario, Canada').");
      }
      state.responses.business_location = { province: businessProvince, country: businessCountry };
      state.step = 4;
      await setPendingTransactionState(from, state);
      return await sendMessage(from, "Please share your email address for your financial dashboard.");
    }

    // Step 4: Collect email
    if (state.step === 4) {
      if (!msg || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(msg)) {
        return await sendMessage(from, "Please provide a valid email address for your financial dashboard.");
      }
      state.responses.email = msg;
      userProfile = {
        ...userProfile,
        user_id: from,
        name: state.responses.name,
        country: state.responses.location.country,
        province: state.responses.location.province,
        business_country: state.responses.business_location.country,
        business_province: state.responses.business_location.province,
        email: msg,
        onboarding_in_progress: false,
        onboarding_completed: true
      };
      await saveUserProfile(userProfile);
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
      return await sendMessage(from, "Please provide your industry (e.g., Construction, Freelancer).");
    }

    // Step 5: Collect industry
    if (state.step === 5) {
      if (!msg) {
        return await sendMessage(from, "Please provide your industry (e.g., Construction, Freelancer).");
      }
      userProfile.industry = msg;
      await saveUserProfile({ ...userProfile, user_id: from });
      state.step = 6;
      await setPendingTransactionState(from, state);
      return await sendMessage(from, "Please set a financial goal (e.g., 'Grow profit by $10000' or 'Pay off $5000 debt').");
    }

    // Step 6: Collect goal
    if (state.step === 6) {
      if (!msg || !msg.match(/\d+/) || (!msg.includes('profit') && !msg.includes('debt'))) {
        return await sendMessage(from, "Invalid goal. Try 'Grow profit by $10000' or 'Pay off $5000 debt'.");
      }
      userProfile.goal = msg;
      userProfile.goalProgress = {
        target: msg.includes('debt')
          ? -parseFloat(msg.match(/\d+/)?.[0] || 5000) * 1000
          : parseFloat(msg.match(/\d+/)?.[0] || 10000) * 1000,
        current: 0
      };
      await saveUserProfile({ ...userProfile, user_id: from });
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
      await deletePendingTransactionState(from);
      return await sendMessage(from, `✅ Goal set: "${msg}" (${currency} ${userProfile.goalProgress.target.toFixed(2)}). You're ready to go!`);
    }

    // Fallback
    return await sendMessage(from, "Unknown onboarding state. Reply 'start onboarding' to begin again.");
  } catch (err) {
    console.error(`[ERROR] handleOnboarding failed for ${from}:`, err.message);
    return await sendMessage(from, `⚠️ Failed to process onboarding: ${err.message}`);
  } finally {
    await releaseLock(lockKey);
  }
}

module.exports = { handleOnboarding };