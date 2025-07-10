const { createUserProfile, saveUserProfile, generateOTP } = require('../../services/postgres');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { sendTemplateMessage, sendMessage } = require('../../services/twilio');
const { confirmationTemplates } = require('../../config');
const { getValidationLists, detectLocation } = require('../../utils/validateLocation');

async function handleOnboarding(from, input, userProfile, ownerId) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    let state = await getPendingTransactionState(from);
    const responseMsg = input?.trim() || '';

    if (!state || responseMsg.toLowerCase() === 'start onboarding') {
      if (userProfile?.onboarding_completed) {
        reply = "You've already completed onboarding. Reply 'help' for commands.";
        return `<Response><Message>${reply}</Message></Response>`;
      }
      const detectedLocation = detectLocation(from);
      state = {
        step: 0,
        responses: {},
        detectedLocation
      };
      await setPendingTransactionState(from, state);
      await createUserProfile({ phone: from, ownerId: from, onboarding_in_progress: true });
      reply = "Welcome to Chief AI! Please reply with your full name.";
      return `<Response><Message>${reply}</Message></Response>`;
    }

    console.log(`[DEBUG] Onboarding state for ${from}: step=${state.step}, response=${responseMsg}`);

    if (state.step === 0) {
      if (!responseMsg) {
        reply = "Please provide your full name to continue.";
        return `<Response><Message>${reply}</Message></Response>`;
      }
      state.responses.name = responseMsg;
      state.step = 1;
      await setPendingTransactionState(from, state);
      await sendTemplateMessage(from, confirmationTemplates.locationConfirmation, [
        { type: 'text', text: state.detectedLocation.province },
        { type: 'text', text: state.detectedLocation.country }
      ]);
      return `<Response></Response>`;
    } else if (state.step === 1) {
      const lcResponse = responseMsg.toLowerCase();
      if (lcResponse === 'yes') {
        state.step = 2;
        state.responses.location = state.detectedLocation;
        await setPendingTransactionState(from, state);
        await sendTemplateMessage(from, confirmationTemplates.businessLocationConfirmation, []);
        return `<Response></Response>`;
      } else if (lcResponse === 'edit') {
        state.step = 1.5;
        await setPendingTransactionState(from, state);
        reply = "Please provide your State/Province, Country (e.g., 'Ontario, Canada').";
        return `<Response><Message>${reply}</Message></Response>`;
      } else if (lcResponse === 'cancel') {
        await deletePendingTransactionState(from);
        await saveUserProfile({ user_id: from, onboarding_in_progress: false });
        reply = "Onboarding cancelled. Reply 'start onboarding' to begin again.";
        return `<Response><Message>${reply}</Message></Response>`;
      } else {
        reply = "Please reply with 'yes', 'edit', or 'cancel' to confirm your location.";
        return `<Response><Message>${reply}</Message></Response>`;
      }
    } else if (state.step === 1.5) {
      if (!responseMsg) {
        reply = "Please provide your State/Province, Country (e.g., 'Ontario, Canada').";
        return `<Response><Message>${reply}</Message></Response>`;
      }

      const { knownProvinces, knownCountries } = getValidationLists();
      const countryAliases = { 'united states': 'United States', 'us': 'United States', 'canada': 'Canada' };

      let manualProvince, manualCountry;
      const match = responseMsg.match(/^(.+?)[\s,]+(.+)$/);
      if (match) {
        manualProvince = match[1].trim();
        manualCountry = match[2].trim();
      } else {
        const parts = responseMsg.trim().split(/\s+/);
        manualCountry = parts.pop();
        manualProvince = parts.join(' ').trim();
      }

      manualCountry = countryAliases[manualCountry.toLowerCase()] || manualCountry;
      const isValidProvince = knownProvinces.some(p => p.toLowerCase() === manualProvince.toLowerCase());
      const isValidCountry = knownCountries.some(c => c.toLowerCase() === manualCountry.toLowerCase());

      if (!isValidProvince || !isValidCountry) {
        state.invalidLocationAttempts = (state.invalidLocationAttempts || 0) + 1;
        if (state.invalidLocationAttempts > 3) {
          await deletePendingTransactionState(from);
          await saveUserProfile({ user_id: from, onboarding_in_progress: false });
          reply = "Too many invalid location attempts. Onboarding cancelled.";
          return `<Response><Message>${reply}</Message></Response>`;
        }
        reply = "Invalid location. Please use 'State/Province, Country' format (e.g., 'Ontario, Canada').";
        return `<Response><Message>${reply}</Message></Response>`;
      }

      state.responses.location = { province: manualProvince, country: manualCountry };
      state.step = 2;
      await setPendingTransactionState(from, state);
      await sendTemplateMessage(from, confirmationTemplates.businessLocationConfirmation, []);
      return `<Response></Response>`;
    } else if (state.step === 2) {
      const lcResponse = responseMsg.toLowerCase();
      if (lcResponse === 'yes') {
        state.step = 3;
        state.responses.business_location = state.responses.location;
        await setPendingTransactionState(from, state);
        reply = "Please share your email address for your financial dashboard.";
        return `<Response><Message>${reply}</Message></Response>`;
      } else if (lcResponse === 'no') {
        state.step = 2.5;
        await setPendingTransactionState(from, state);
        reply = "Please provide your business's registered State/Province, Country (e.g., 'Ontario, Canada').";
        return `<Response><Message>${reply}</Message></Response>`;
      } else if (lcResponse === 'cancel') {
        await deletePendingTransactionState(from);
        await saveUserProfile({ user_id: from, onboarding_in_progress: false });
        reply = "Onboarding cancelled. Reply 'start onboarding' to begin again.";
        return `<Response><Message>${reply}</Message></Response>`;
      } else {
        reply = "Please reply with 'yes', 'no', or 'cancel' to confirm your business location.";
        return `<Response><Message>${reply}</Message></Response>`;
      }
    } else if (state.step === 2.5) {
      if (!responseMsg) {
        reply = "Please provide your business's registered State/Province, Country (e.g., 'Ontario, Canada').";
        return `<Response><Message>${reply}</Message></Response>`;
      }

      const { knownProvinces, knownCountries } = getValidationLists();
      const countryAliases = { 'united states': 'United States', 'us': 'United States', 'canada': 'Canada' };

      let businessProvince, businessCountry;
      const match = responseMsg.match(/^(.+?)[\s,]+(.+)$/);
      if (match) {
        businessProvince = match[1].trim();
        businessCountry = match[2].trim();
      } else {
        const parts = responseMsg.trim().split(/\s+/);
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
          reply = "Too many invalid location attempts. Onboarding cancelled.";
          return `<Response><Message>${reply}</Message></Response>`;
        }
        reply = "Invalid business location. Please use 'State/Province, Country' format (e.g., 'Ontario, Canada').";
        return `<Response><Message>${reply}</Message></Response>`;
      }

      state.responses.business_location = { province: businessProvince, country: businessCountry };
      state.step = 3;
      await setPendingTransactionState(from, state);
      reply = "Please share your email address for your financial dashboard.";
      return `<Response><Message>${reply}</Message></Response>`;
    } else if (state.step === 3) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!responseMsg || !emailRegex.test(responseMsg)) {
        reply = "Please provide a valid email address for your financial dashboard.";
        return `<Response><Message>${reply}</Message></Response>`;
      }

      state.responses.email = responseMsg;
      userProfile.user_id = from;
      userProfile.name = state.responses.name;
      userProfile.country = state.responses.location.country;
      userProfile.province = state.responses.location.province;
      userProfile.business_country = state.responses.business_location.country;
      userProfile.business_province = state.responses.business_location.province;
      userProfile.email = responseMsg;
      userProfile.onboarding_in_progress = false;
      userProfile.onboarding_completed = true;

      await saveUserProfile(userProfile);
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
💵 Logging Revenue: Got a $7,500 payment from Jack.
📊 Getting Metrics: How long did it take to complete Jack's job and how much did I make?

Your financial dashboard is ready! Visit: ${dashboardUrl}
You'll receive a one-time code via WhatsApp to access it.
A quick walkthrough video is on its way.
Let’s build something great.
— Chief 💼`;
      await sendMessage(from, congratsMessage);
      await deletePendingTransactionState(from);
      return `<Response></Response>`;
    } else if (state.dynamicStep === 'industry') {
      if (!responseMsg) {
        reply = "Please provide your industry (e.g., Construction, Freelancer).";
        return `<Response><Message>${reply}</Message></Response>`;
      }
      userProfile.industry = responseMsg;
      await saveUserProfile({ ...userProfile, user_id: from });
      reply = `✅ Industry set to ${responseMsg}. Keep logging—next up, set a financial goal with 'goal $10000 profit'.`;
      await deletePendingTransactionState(from);
      return `<Response><Message>${reply}</Message></Response>`;
    } else if (state.dynamicStep === 'goal') {
      if (!responseMsg || !responseMsg.match(/\d+/) || (!responseMsg.includes('profit') && !responseMsg.includes('debt'))) {
        reply = "Invalid goal. Try 'Grow profit by $10000' or 'Pay off $5000 debt'.";
        return `<Response><Message>${reply}</Message></Response>`;
      }
      userProfile.goal = responseMsg;
      userProfile.goalProgress = {
        target: responseMsg.includes('debt')
          ? -parseFloat(responseMsg.match(/\d+/)?.[0] || 5000) * 1000
          : parseFloat(responseMsg.match(/\d+/)?.[0] || 10000) * 1000,
        current: 0
      };
      await saveUserProfile({ ...userProfile, user_id: from });
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
      reply = `✅ Goal set: "${responseMsg}" (${currency} ${userProfile.goalProgress.target.toFixed(2)}). You're ready to go!`;
      await deletePendingTransactionState(from);
      return `<Response><Message>${reply}</Message></Response>`;
    } else {
      reply = "Unknown onboarding state. Reply 'start onboarding' to begin again.";
      return `<Response><Message>${reply}</Message></Response>`;
    }
  } catch (error) {
    console.error(`[ERROR] handleOnboarding failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process onboarding: ${error.message}`;
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    await require('../middleware/lock').releaseLock(lockKey);
  }
}

module.exports = { handleOnboarding };