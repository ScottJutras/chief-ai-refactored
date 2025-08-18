const { createUserProfile, saveUserProfile, generateOTP, getUserProfile } = require('../services/postgres');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState, clearUserState } = require('../utils/stateManager');
const { sendTemplateMessage, sendMessage } = require('../services/twilio');
const { confirmationTemplates } = require('../config');
const { getValidationLists, detectLocation } = require('../utils/validateLocation');
const { handleInputWithAI, handleError } = require('../utils/aiErrorHandler');

// ---- Helpers

const REQUIRED_PROFILE_FIELDS = ['user_id', 'phone']; // profile without phone = trigger fresh onboarding

function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}
function isProfileIncomplete(profile) {
  if (!profile) return true;
  return REQUIRED_PROFILE_FIELDS.some(k => (k in profile ? isBlank(profile[k]) : true));
}

/**
 * Ensures we always pass Twilio Content param objects.
 * Example: ['Ontario','Canada'] -> [{type:'text',text:'Ontario'},{type:'text',text:'Canada'}]
 */
function toTwilioParams(params = []) {
  return params.map(p => (typeof p === 'string' ? { type: 'text', text: p } : p));
}

/**
 * Sends a template message if SID exists, else falls back to a provided text.
 */
async function sendTemplateOrText(from, templateSid, params, fallbackText) {
  if (templateSid) {
    return sendTemplateMessage(from, templateSid, toTwilioParams(params));
  }
  if (fallbackText) {
    return sendMessage(from, fallbackText);
  }
}

/**
 * Bootstraps a blank onboarding state
 */
function newState(from) {
  return {
    step: 1,
    responses: {},
    detectedLocation: detectLocation(from), // {province, country}
    invalidAttempts: {}
  };
}

// ---- Handler

async function handleOnboarding(from, input, userProfile, ownerId, res) {
  try {
    const msgRaw = input || '';
    const msg = msgRaw.trim().toLowerCase();
    const wantsReset = msg === 'reset onboarding' || msg === 'start onboarding';

    // Always fetch fresh profile from DB to avoid stale data from middleware
    let dbProfile = null;
    try { dbProfile = await getUserProfile(from); } catch (_) {}
    let profile = dbProfile || userProfile || null;

    const hasDbUser = !!dbProfile;
    const missingRequiredFields = isProfileIncomplete(dbProfile);

    // ---- Reset conditions
    if (wantsReset || !hasDbUser || missingRequiredFields) {
      // Clear conversational state + any locks (if your clearUserState deletes from locks table too)
      await clearUserState(from).catch(() => {});
      if (!hasDbUser) {
        profile = await createUserProfile({ user_id: from, ownerId: from, onboarding_in_progress: true, onboarding_completed: false });
      } else {
        // Mark for (re)onboarding if row exists but is incomplete (e.g., phone was removed)
        profile = { ...dbProfile, onboarding_in_progress: true, onboarding_completed: false };
        await saveUserProfile(profile);
      }

      const state = newState(from);
      await setPendingTransactionState(from, state);
      return res.send(`<Response><Message>Welcome to Chief AI! Please reply with your full name.</Message></Response>`);
    }

    // ---- Load or create state
    let state = await getPendingTransactionState(from);
    if (!state) {
      state = newState(from);
      await setPendingTransactionState(from, state);
      return res.send(`<Response><Message>Welcome to Chief AI! Please reply with your full name.</Message></Response>`);
    }

    // ---- Step 1: capture full name -> send location confirmation template
    if (state.step === 1) {
      const name = msgRaw.trim();
      if (!name || name.length < 2) {
        return res.send(`<Response><Message>Please provide your full name to continue.</Message></Response>`);
      }
      state.responses.name = name;
      state.step = 2;
      await setPendingTransactionState(from, state);

      // Quick reply template for personal location
      await sendTemplateOrText(
        from,
        confirmationTemplates.locationConfirmation,
        [state.detectedLocation.province, state.detectedLocation.country],
        `I detected your location as ${state.detectedLocation.province}, ${state.detectedLocation.country}. Reply: Yes / Edit / Cancel`
      );
      return res.send(`<Response></Response>`);
    }

    // ---- Step 2: confirm detected location
    if (state.step === 2) {
      if (msg === 'yes') {
        state.responses.location = state.detectedLocation;
        state.step = 3;
        await setPendingTransactionState(from, state);

        // Quick reply template asking if business location is the same
        await sendTemplateOrText(
          from,
          confirmationTemplates.businessLocationConfirmation,
          [],
          `Is your business registered in the same location? Reply: Yes / No / Cancel`
        );
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

    // ---- Step 2.5: manual personal location entry
    if (state.step === 2.5) {
      const { knownProvinces, knownCountries } = getValidationLists();
      const countryAliases = { 'united states': 'United States', 'us': 'United States', 'canada': 'Canada' };
      const defaultData = { province: '', country: '' };

      const parseFn = (raw) => {
        const input = String(raw || '');
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
        const normCountry = countryAliases[(country || '').toLowerCase()] || country;
        const isValidProvince = knownProvinces.some(p => p.toLowerCase() === (province || '').toLowerCase());
        const isValidCountry = knownCountries.some(c => c.toLowerCase() === (normCountry || '').toLowerCase());
        if (!isValidProvince || !isValidCountry) return null;
        return { province, country: normCountry };
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

      await sendTemplateOrText(
        from,
        confirmationTemplates.businessLocationConfirmation,
        [],
        `Is your business registered in the same location? Reply: Yes / No / Cancel`
      );
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

    // ---- Step 3.5: manual business location entry
    if (state.step === 3.5) {
      const { knownProvinces, knownCountries } = getValidationLists();
      const countryAliases = { 'united states': 'United States', 'us': 'United States', 'canada': 'Canada' };
      const defaultData = { province: '', country: '' };

      const parseFn = (raw) => {
        const input = String(raw || '');
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
        const normCountry = countryAliases[(country || '').toLowerCase()] || country;
        const isValidProvince = knownProvinces.some(p => p.toLowerCase() === (province || '').toLowerCase());
        const isValidCountry = knownCountries.some(c => c.toLowerCase() === (normCountry || '').toLowerCase());
        if (!isValidProvince || !isValidCountry) return null;
        return { province, country: normCountry };
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

    // ---- Step 4: capture email, send dashboard link + onboarding tips
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

      // If you have a template for sending links, use it; else send plain text
      await sendTemplateOrText(
        from,
        confirmationTemplates.spreadsheetLink,
        [dashboardUrl],
        `Your financial dashboard is ready: ${dashboardUrl}`
      );

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

      state.step = 5; // continue to next phase (industry)
      await setPendingTransactionState(from, state);
      return res.send(`<Response><Message>Please provide your industry (e.g., Construction, Freelancer).</Message></Response>`);
    }

    // ---- Step 5: industry -> (example: send goal options template if you want)
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

      // Optional quick reply template for goals if configured
      if (confirmationTemplates.goalOptions) {
        await sendTemplateMessage(from, confirmationTemplates.goalOptions, []);
        return res.send(`<Response></Response>`);
      }
      return res.send(`<Response><Message>What’s your financial goal? (e.g., “Grow profit by $10,000” or “Pay off $5,000 debt”)</Message></Response>`);
    }

    // ---- Step 6: simple goal parse example; finalize onboarding
    if (state.step === 6) {
      const defaultData = { goal: '', amount: 0 };
      const parseFn = (raw) => {
        const match = String(raw || '').match(/(grow profit by|pay off)\s+\$?(\d+(?:\.\d{1,2})?)/i);
        if (!match) return null;
        const goalType = match[1].toLowerCase();
        const amount = parseFloat(match[2]) * 1000; // your legacy multiplier
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
        return res.send(`<Response><Message>${reply || "Try something like 'Grow profit by $10000' or 'Pay off $5000 debt'."}</Message></Response>`);
      }

      profile.goal = data.goal;
      profile.goal_progress = {
        target: data.goal.includes('debt') ? -data.amount : data.amount,
        current: 0
      };

      await saveUserProfile({ ...profile, onboarding_in_progress: false, onboarding_completed: true });
      const currency = profile.country === 'United States' ? 'USD' : 'CAD';
      await deletePendingTransactionState(from);

      return res.send(
        `<Response><Message>✅ Goal set: "${data.goal}" (${currency} ${profile.goal_progress.target.toFixed(2)}). You're ready to go!</Message></Response>`
      );
    }

    // Fallback
    return res.send(`<Response><Message>Unknown onboarding state. Reply 'start onboarding' to begin again.</Message></Response>`);
  } catch (error) {
    console.error('[ERROR] handleOnboarding failed for', from, ':', error.message);
    const xml = await handleError(from, error, 'handleOnboarding', input);
    return res.send(xml);
  }
}

module.exports = { handleOnboarding };
