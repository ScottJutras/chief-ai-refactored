const { createUserProfile, saveUserProfile, generateOTP, getUserProfile } = require('../services/postgres');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState, clearUserState } = require('../utils/stateManager');
const { sendTemplateMessage, sendMessage } = require('../services/twilio');
const { confirmationTemplates } = require('../config');
const { getValidationLists, detectLocation } = require('../utils/validateLocation');
const { handleInputWithAI, handleError } = require('../utils/aiErrorHandler');

// ========= Configured SIDs (force quick reply to render) =========
// Use env if present; fall back to your known good SIDs.
const QUICK_REPLY_LOCATION_SID =
  confirmationTemplates.locationConfirmation || 'HX0280df498999848aaff04cc079e16c31';
const QUICK_REPLY_BUSINESS_LOCATION_SID =
  confirmationTemplates.businessLocationConfirmation || 'HXa885f78d7654642672bfccfae98d57cb';

// Treat the profile as "incomplete" if any of these are empty/null/undefined
const REQUIRED_PROFILE_FIELDS = ['user_id', 'phone']; // update to match your column names if needed

function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}
function isProfileIncomplete(profile) {
  if (!profile) return true;
  return REQUIRED_PROFILE_FIELDS.some(k => (k in profile ? isBlank(profile[k]) : true));
}

function newState(from) {
  return {
    step: 1,
    responses: {},
    detectedLocation: detectLocation(from), // { province, country }
    invalidAttempts: {}
  };
}

async function handleOnboarding(from, input, userProfile, ownerId, res) {
  try {
    const msgRaw = input || '';
    const msg = msgRaw.trim().toLowerCase();
    const wantsReset = msg === 'reset onboarding' || msg === 'start onboarding';

    // Always fetch a fresh profile from DB
    let dbProfile = null;
    try { dbProfile = await getUserProfile(from); } catch (_) {}
    let profile = dbProfile || userProfile || null;

    const hasDbUser = !!dbProfile;
    const missingRequiredFields = isProfileIncomplete(dbProfile);

    // Reset when: explicit reset OR no DB row OR incomplete profile (e.g., phone removed)
    if (wantsReset || !hasDbUser || missingRequiredFields) {
      await clearUserState(from).catch(() => {});
      if (!hasDbUser) {
        profile = await createUserProfile({
          user_id: from,
          ownerId: from,
          onboarding_in_progress: true,
          onboarding_completed: false
        });
      } else {
        profile = { ...dbProfile, onboarding_in_progress: true, onboarding_completed: false };
        await saveUserProfile(profile);
      }

      const state = newState(from);
      await setPendingTransactionState(from, state);
      return res.send(`<Response><Message>Welcome to Chief AI! Please reply with your full name.</Message></Response>`);
    }

    // Load or initialize state
    let state = await getPendingTransactionState(from);
    if (!state) {
      state = newState(from);
      await setPendingTransactionState(from, state);
      return res.send(`<Response><Message>Welcome to Chief AI! Please reply with your full name.</Message></Response>`);
    }

    // ---- Step 1: capture full name -> send location confirmation (Quick Reply)
    if (state.step === 1) {
      const name = msgRaw.trim();
      if (!name || name.length < 2) {
        return res.send(`<Response><Message>Please provide your full name to continue.</Message></Response>`);
      }
      state.responses.name = name;
      state.step = 2;
      await setPendingTransactionState(from, state);

      // FORCE the Twilio Quick Reply template; then return empty TwiML
      console.log('[TEMPLATE] locationConfirmation SID =', QUICK_REPLY_LOCATION_SID, state.detectedLocation);
      await sendTemplateMessage(
        from,
        QUICK_REPLY_LOCATION_SID,
        [ state.detectedLocation.province, state.detectedLocation.country ] // order matches your template: {{1}}, {{2}}
      );
      return res.send(`<Response></Response>`);
    }

    // ---- Step 2: confirm detected location
    if (state.step === 2) {
      if (msg === 'yes') {
        state.responses.location = state.detectedLocation;
        state.step = 3;
        await setPendingTransactionState(from, state);

        // Business location same? Quick Reply
        console.log('[TEMPLATE] businessLocationConfirmation SID =', QUICK_REPLY_BUSINESS_LOCATION_SID);
        await sendTemplateMessage(from, QUICK_REPLY_BUSINESS_LOCATION_SID, []);
        return res.send(`<Response></Response>`);
      } else if (msg === 'edit') {
        state.step = 2.5;
        await setPendingTransactionState(from, state);
        return res.send(`<Response><Message>Please provide your State/Province, Country (e.g., 'Ontario, Canada').</Message></Response>`);
      } else if (msg === 'cancel') {
        await deletePendingTransactionState(from);
        await saveUserProfile({ ...profile, onboarding_in_progress: false });
        return res.send(`<Response><Message>Onboarding cancelled. Reply 'start onboarding' to begin again.</Message></Response>`);
      } else {
        return res.send(`<Response><Message>Please reply with 'yes', 'edit', or 'cancel' to confirm your location.</Message></Response>`);
      }
    }

    // ---- Step 2.5: manual personal location
    if (state.step === 2.5) {
      const { knownProvinces, knownCountries } = getValidationLists();
      const countryAliases = { 'united states': 'United States', 'us': 'United States', 'canada': 'Canada' };
      const defaultData = { province: '', country: '' };

      const parseFn = (raw) => {
        const inputStr = String(raw || '');
        let province, country;
        const match = inputStr.match(/^(.+?)[\s,]+(.+)$/i);
        if (match) {
          province = match[1].trim();
          country = match[2].trim();
        } else {
          const parts = inputStr.trim().split(/\s+/);
          country = parts.pop();
          province = parts.join(' ').trim();
        }
        country = countryAliases[country.toLowerCase()] || country;
        const isValidProvince = knownProvinces.some(p => p.toLowerCase() === (province || '').toLowerCase());
        const isValidCountry = knownCountries.some(c => c.toLowerCase() === (country || '').toLowerCase());
        if (!isValidProvince || !isValidCountry) return null;
        return { province, country };
      };

      const { data, reply, confirmed } = await handleInputWithAI(from, msgRaw, 'location', parseFn, defaultData);
      if (!confirmed) {
        state.invalidAttempts.location = (state.invalidAttempts.location || 0) + 1;
        if (state.invalidAttempts.location > 3) {
          await deletePendingTransactionState(from);
          await saveUserProfile({ ...profile, onboarding_in_progress: false });
          return res.send(`<Response><Message>Too many invalid location attempts. Onboarding cancelled.</Message></Response>`);
        }
        await setPendingTransactionState(from, state);
        return res.send(
          `<Response><Message>${reply || "Invalid location. Please use 'State/Province, Country' format (e.g., 'Ontario, Canada')."}</Message></Response>`
        );
      }

      state.responses.location = data;
      state.invalidAttempts.location = 0;
      state.step = 3;
      await setPendingTransactionState(from, state);

      console.log('[TEMPLATE] businessLocationConfirmation SID =', QUICK_REPLY_BUSINESS_LOCATION_SID);
      await sendTemplateMessage(from, QUICK_REPLY_BUSINESS_LOCATION_SID, []);
      return res.send(`<Response></Response>`);
    }

    // ---- Step 3: confirm business location equals personal?
    if (state.step === 3) {
      if (msg === 'yes') {
        state.responses.business_location = state.responses.location;
        state.step = 4;
        await setPendingTransactionState(from, state);
        return res.send(`<Response><Message>Please share your email address for your financial dashboard.</Message></Response>`);
      } else if (msg === 'no') {
        state.step = 3.5;
        await setPendingTransactionState(from, state);
        return res.send(`<Response><Message>Please provide your business's registered State/Province, Country (e.g., 'Ontario, Canada').</Message></Response>`);
      } else if (msg === 'cancel') {
        await deletePendingTransactionState(from);
        await saveUserProfile({ ...profile, onboarding_in_progress: false });
        return res.send(`<Response><Message>Onboarding cancelled. Reply 'start onboarding' to begin again.</Message></Response>`);
      } else {
        return res.send(`<Response><Message>Please reply with 'yes', 'no', or 'cancel' to confirm your business location.</Message></Response>`);
      }
    }

    // ---- Step 3.5: manual business location
    if (state.step === 3.5) {
      const { knownProvinces, knownCountries } = getValidationLists();
      const countryAliases = { 'united states': 'United States', 'us': 'United States', 'canada': 'Canada' };
      const defaultData = { province: '', country: '' };

      const parseFn = (raw) => {
        const inputStr = String(raw || '');
        let province, country;
        const match = inputStr.match(/^(.+?)[\s,]+(.+)$/i);
        if (match) {
          province = match[1].trim();
          country = match[2].trim();
        } else {
          const parts = inputStr.trim().split(/\s+/);
          country = parts.pop();
          province = parts.join(' ').trim();
        }
        country = countryAliases[country.toLowerCase()] || country;
        const isValidProvince = knownProvinces.some(p => p.toLowerCase() === (province || '').toLowerCase());
        const isValidCountry = knownCountries.some(c => c.toLowerCase() === (country || '').toLowerCase());
        if (!isValidProvince || !isValidCountry) return null;
        return { province, country };
      };

      const { data, reply, confirmed } = await handleInputWithAI(from, msgRaw, 'business_location', parseFn, defaultData);
      if (!confirmed) {
        state.invalidAttempts.business_location = (state.invalidAttempts.business_location || 0) + 1;
        if (state.invalidAttempts.business_location > 3) {
          await deletePendingTransactionState(from);
          await saveUserProfile({ ...profile, onboarding_in_progress: false });
          return res.send(`<Response><Message>Too many invalid location attempts. Onboarding cancelled.</Message></Response>`);
        }
        await setPendingTransactionState(from, state);
        return res.send(
          `<Response><Message>${reply || "Invalid business location. Please use 'State/Province, Country' format (e.g., 'Ontario, Canada')."}</Message></Response>`
        );
      }

      state.responses.business_location = data;
      state.invalidAttempts.business_location = 0;
      state.step = 4;
      await setPendingTransactionState(from, state);
      return res.send(`<Response><Message>Please share your email address for your financial dashboard.</Message></Response>`);
    }

    // ---- Step 4: email
    if (state.step === 4) {
      const email = msgRaw.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        state.invalidAttempts.email = (state.invalidAttempts.email || 0) + 1;
        if (state.invalidAttempts.email > 3) {
          await deletePendingTransactionState(from);
          await saveUserProfile({ ...profile, onboarding_in_progress: false });
          return res.send(`<Response><Message>Too many invalid attempts. Onboarding cancelled.</Message></Response>`);
        }
        await setPendingTransactionState(from, state);
        return res.send(`<Response><Message>Please provide a valid email address for your financial dashboard.</Message></Response>`);
      }

      state.responses.email = email;
      state.invalidAttempts.email = 0;

      const userProfileData = {
        ...profile,
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

      profile = await getUserProfile(from);
      await generateOTP(from);

      const dashboardUrl = `https://chief-ai-refactored.vercel.app/dashboard/${from}?token=${profile.dashboard_token}`;

      // If you have a template for the link, use it; else send plain text
      if (confirmationTemplates.spreadsheetLink) {
        console.log('[TEMPLATE] spreadsheetLink SID =', confirmationTemplates.spreadsheetLink);
        await sendTemplateMessage(from, confirmationTemplates.spreadsheetLink, [dashboardUrl]);
      } else {
        await sendMessage(from, `Your financial dashboard is ready: ${dashboardUrl}`);
      }

      const name = profile.name || 'there';
      const congratsMessage = `Congratulations ${name}!
You’ve now got a personal CFO — in your pocket — on demand.
Real-time. Data-smart. Built to make your business *make sense*.
📈 We’re talking:
— Auto-tracking your money
— Instant profit breakdowns
— No more “where did it all go?”
— Absolute clarity on every move 💸
Start simple. Try messages like:
🧱 Start Jack's renovation today
🧾 Spent $980 at Home Depot for lumber
🚚 Add monthly truck payment $760
💬 What do I need to earn this month to pay all of my bills?
⏱ Clock in / Break / Clock out
🛠 Pause Jack's renovation
✅ Finished Jack's renovation
💵 Got a $7,500 payment from J
📊 How long did Jack's job take and how much did I make?
Your dashboard link: ${dashboardUrl}
You'll receive a one-time code via WhatsApp to access it.
— Chief 💼`;
      await sendMessage(from, congratsMessage);

      state.step = 5;
      await setPendingTransactionState(from, state);
      return res.send(`<Response><Message>Please provide your industry (e.g., Construction, Freelancer).</Message></Response>`);
    }

    // ---- Step 5: industry
    if (state.step === 5) {
      const industry = msgRaw.trim();
      if (!industry || industry.length < 3) {
        state.invalidAttempts.industry = (state.invalidAttempts.industry || 0) + 1;
        if (state.invalidAttempts.industry > 3) {
          await deletePendingTransactionState(from);
          await saveUserProfile({ ...profile, onboarding_in_progress: false });
          return res.send(`<Response><Message>Too many invalid attempts. Onboarding cancelled.</Message></Response>`);
        }
        await setPendingTransactionState(from, state);
        return res.send(`<Response><Message>Please provide your industry (e.g., Construction, Freelancer).</Message></Response>`);
      }
      profile.industry = industry;
      state.invalidAttempts.industry = 0;
      await saveUserProfile({ ...profile, user_id: from });

      state.step = 6;
      await setPendingTransactionState(from, state);

      // If you later add a quick-reply for goals, call it here.
      return res.send(`<Response><Message>What’s your financial goal? (e.g., “Grow profit by $10,000” or “Pay off $5,000 debt”)</Message></Response>`);
    }

    // ---- Step 6: goal
    if (state.step === 6) {
      const defaultData = { goal: '', amount: 0 };
      const parseFn = (raw) => {
        const match = String(raw || '').match(/(grow profit by|pay off)\s+\$?(\d+(?:\.\d{1,2})?)/i);
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
          await saveUserProfile({ ...profile, onboarding_in_progress: false });
          return res.send(`<Response><Message>Too many invalid attempts. Onboarding cancelled.</Message></Response>`);
        }
        await setPendingTransactionState(from, state);
        return res.send(`<Response><Message>${reply || "Try 'Grow profit by $10000' or 'Pay off $5000 debt'."}</Message></Response>`);
      }

      profile.goal = data.goal;
      profile.goal_progress = {
        target: data.goal.includes('debt') ? -data.amount : data.amount,
        current: 0
      };

      await saveUserProfile({ ...profile, onboarding_in_progress: false, onboarding_completed: true });
      const currency = profile.country === 'United States' ? 'USD' : 'CAD';
      await deletePendingTransactionState(from);

      return res.send(`<Response><Message>✅ Goal set: "${data.goal}" (${currency} ${profile.goal_progress.target.toFixed(2)}). You're ready to go!</Message></Response>`);
    }

    return res.send(`<Response><Message>Unknown onboarding state. Reply 'start onboarding' to begin again.</Message></Response>`);
  } catch (error) {
    console.error('[ERROR] handleOnboarding failed for', from, ':', error.message);
    const xml = await handleError(from, error, 'handleOnboarding', input);
    return res.send(xml);
  }
}

module.exports = { handleOnboarding };
