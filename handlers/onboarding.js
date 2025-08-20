// handlers/onboarding.js
const {
  createUserProfile,
  saveUserProfile,
  generateOTP,
  getUserProfile,
} = require('../services/postgres');
const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState,
  clearUserState,
} = require('../utils/stateManager');
const { sendTemplateMessage, sendQuickReply, sendMessage } = require('../services/twilio');
const { getValidationLists, detectLocation } = require('../utils/validateLocation');
const { handleInputWithAI, handleError } = require('../utils/aiErrorHandler');
const { ack } = require('../utils/http');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// --- utils ---
function normalizePhoneNumber(from = '') {
  const val = String(from || '');
  const noWa = val.startsWith('whatsapp:') ? val.slice('whatsapp:'.length) : val;
  return noWa.replace(/^\+/, '').trim();
}
function reply(res, text) {
  if (!res.headersSent) {
    res.status(200).send(`<Response><Message>${text}</Message></Response>`);
  }
}
function cap(s = '') {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Treat the profile as "incomplete" if any of these are empty
const REQUIRED_PROFILE_FIELDS = ['user_id'];

function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}
function isProfileIncomplete(profile) {
  if (!profile) return true;
  return REQUIRED_PROFILE_FIELDS.some(k => !profile[k] || isBlank(profile[k]));
}

// Subscription check using the already-fetched profile
async function checkSubscriptionFromProfile(profile) {
  try {
    if (!profile) return false;
    const subId = profile.stripe_subscription_id;
    if (!subId) return false;
    const sub = await stripe.subscriptions.retrieve(subId);
    // allow active or trialing; tweak if you want to allow 'past_due'
    return sub.status === 'active' || sub.status === 'trialing';
  } catch (err) {
    console.error('[ERROR] Stripe subscription check failed:', err.message);
    return false;
  }
}

/**
 * Multi-step onboarding:
 * 1) name
 * 2) personal location confirm (yes/edit/cancel)
 * 2.5) manual personal location input
 * 3) business location confirm (yes/no/cancel)
 * 3.5) manual business location input
 * 4) email -> OTP + dashboard link (and a friendly getting-started message)
 * 5) industry
 * 6) goal -> complete
 */
async function handleOnboarding(from, input, userProfile, ownerId, res) {
  const msgRaw = (input || '').trim();
  const msg = msgRaw.toLowerCase();
  const normalizedFrom = normalizePhoneNumber(from);

  try {
    // Always fetch fresh DB profile first
    let dbProfile = null;
    try {
      dbProfile = await getUserProfile(normalizedFrom);
    } catch (_) {}
    let profile = dbProfile || userProfile || null;
    const hasDbUser = !!dbProfile;

    // Subscription gate (after profile fetch so we don't need pool)
    const wantsReset = msg === 'reset onboarding' || msg === 'start onboarding';
    const isSubActive = await checkSubscriptionFromProfile(dbProfile);
    if (!isSubActive && !wantsReset) {
      await sendMessage(
        normalizedFrom,
        'Please activate your subscription to start onboarding. Visit https://chief-ai-refactored.vercel.app/subscribe.'
      );
      return ack(res);
    }

    // Reset flow if requested
    if (wantsReset) {
      await clearUserState(normalizedFrom).catch(() => {});
      if (!hasDbUser) {
        profile = await createUserProfile({
          user_id: normalizedFrom,
          ownerId: normalizedFrom,
          onboarding_in_progress: true,
        });
      } else {
        profile = { ...dbProfile, onboarding_in_progress: true, onboarding_completed: false };
        await saveUserProfile(profile);
      }
      const state = {
        step: 1,
        responses: {},
        detectedLocation: detectLocation(normalizedFrom),
        invalidAttempts: {},
      };
      await setPendingTransactionState(normalizedFrom, state);

      await sendMessage(normalizedFrom, 'Welcome to Chief AI! Please reply with your full name.');
      return ack(res);
    }

    // Bootstrap state if needed
    let state = await getPendingTransactionState(normalizedFrom);
    if (!state || !hasDbUser || isProfileIncomplete(dbProfile)) {
      if (!hasDbUser) {
        profile = await createUserProfile({
          user_id: normalizedFrom,
          ownerId: normalizedFrom,
          onboarding_in_progress: true,
        });
      } else {
        profile = { ...dbProfile, onboarding_in_progress: true, onboarding_completed: false };
        await saveUserProfile(profile);
      }
      state = {
        step: 1,
        responses: {},
        detectedLocation: detectLocation(normalizedFrom),
        invalidAttempts: {},
      };
      await setPendingTransactionState(normalizedFrom, state);
      await sendMessage(normalizedFrom, 'Welcome to Chief AI! Please reply with your full name.');
      return ack(res);
    }

    // --- STEP MACHINE ---
    // Step 1: capture full name
    if (state.step === 1) {
      const name = msgRaw.trim();
      if (!name || name.length < 2) {
        await sendMessage(normalizedFrom, 'Please provide your full name to continue.');
        return ack(res);
      }

      state.responses.name = cap(name);
      state.step = 2;
      await setPendingTransactionState(normalizedFrom, state);

      try {
        await sendTemplateMessage(
          normalizedFrom,
          'HX0280df498999848aaff04cc079e16c31',
          { '1': state.responses.name, '2': state.detectedLocation.province, '3': state.detectedLocation.country }
        );
        return ack(res);
      } catch (error) {
        console.error('[ERROR] Template message failed, falling back to quick reply:', error.message, error.code, error.moreInfo);
        await sendQuickReply(
          normalizedFrom,
          `Hi ${state.responses.name}! I detected you’re in ${state.detectedLocation.province}, ${state.detectedLocation.country}. Is that correct?`,
          ['yes', 'edit', 'cancel']
        );
        return ack(res);
      }
    }

    // Step 2: confirm detected personal location
    if (state.step === 2) {
      if (msg === 'yes') {
        state.responses.location = state.detectedLocation;
        state.step = 3;
        await setPendingTransactionState(normalizedFrom, state);

        try {
          await sendTemplateMessage(
            normalizedFrom,
            'HXa885f78d7654642672bfccfae98d57cb',
            {}
          );
          return ack(res);
        } catch (error) {
          console.error('[ERROR] Template message failed, falling back to quick reply:', error.message, error.code, error.moreInfo);
          await sendQuickReply(
            normalizedFrom,
            `Is your business registered in the same place?`,
            ['yes', 'no', 'cancel']
          );
          return ack(res);
        }
      }
      if (msg === 'edit') {
        state.step = 2.5;
        await setPendingTransactionState(normalizedFrom, state);
        await sendMessage(normalizedFrom, `Please provide your State/Province, Country (e.g., 'Ontario, Canada').`);
        return ack(res);
      }
      if (msg === 'cancel') {
        await deletePendingTransactionState(normalizedFrom);
        await saveUserProfile({ ...profile, onboarding_in_progress: false });
        await sendMessage(normalizedFrom, `Onboarding cancelled. Reply 'start onboarding' to begin again.`);
        return ack(res);
      }
      await sendMessage(normalizedFrom, `Please reply with 'yes', 'edit', or 'cancel' to confirm your location.`);
      return ack(res);
    }

    // Step 2.5: manual personal location
    if (state.step === 2.5) {
      const { knownProvinces, knownCountries } = getValidationLists();
      const countryAliases = { 'united states': 'United States', us: 'United States', canada: 'Canada' };
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
        const canonicalCountry = countryAliases[country.toLowerCase()] || country;
        const isValidProvince = knownProvinces.some(p => p.toLowerCase() === province.toLowerCase());
        const isValidCountry = knownCountries.some(c => c.toLowerCase() === canonicalCountry.toLowerCase());
        if (!isValidProvince || !isValidCountry) return null;
        return { province, country: canonicalCountry };
      };

      const { data, reply: aiReply, confirmed } = await handleInputWithAI(
        normalizedFrom,
        msgRaw,
        'location',
        parseFn,
        defaultData
      );

      if (!confirmed) {
        state.invalidAttempts.location = (state.invalidAttempts.location || 0) + 1;
        if (state.invalidAttempts.location > 3) {
          await deletePendingTransactionState(normalizedFrom);
          await saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(normalizedFrom, `Too many invalid location attempts. Onboarding cancelled.`);
          return ack(res);
        }
        await setPendingTransactionState(normalizedFrom, state);
        await sendMessage(
          normalizedFrom,
          aiReply || `Invalid location. Please use 'State/Province, Country' format (e.g., 'Ontario, Canada').`
        );
        return ack(res);
      }

      state.responses.location = data;
      state.invalidAttempts.location = 0;
      state.step = 3;
      await setPendingTransactionState(normalizedFrom, state);

      try {
        await sendTemplateMessage(
          normalizedFrom,
          'HXa885f78d7654642672bfccfae98d57cb',
          {}
        );
        return ack(res);
      } catch (error) {
        console.error('[ERROR] Template message failed, falling back to quick reply:', error.message, error.code, error.moreInfo);
        await sendQuickReply(
          normalizedFrom,
          `Is your business registered in the same place?`,
          ['yes', 'no', 'cancel']
        );
        return ack(res);
      }
    }

    // Step 3: confirm business location
    if (state.step === 3) {
      if (msg === 'yes') {
        state.responses.business_location = state.responses.location;
        state.step = 4;
        await setPendingTransactionState(normalizedFrom, state);
        await sendMessage(normalizedFrom, `Please share your email address for your financial dashboard.`);
        return ack(res);
      }
      if (msg === 'no') {
        state.step = 3.5;
        await setPendingTransactionState(normalizedFrom, state);
        await sendMessage(normalizedFrom, `Please provide your business's registered State/Province, Country (e.g., 'Ontario, Canada').`);
        return ack(res);
      }
      if (msg === 'cancel') {
        await deletePendingTransactionState(normalizedFrom);
        await saveUserProfile({ ...profile, onboarding_in_progress: false });
        await sendMessage(normalizedFrom, `Onboarding cancelled. Reply 'start onboarding' to begin again.`);
        return ack(res);
      }
      await sendMessage(normalizedFrom, `Please reply with 'yes', 'no', or 'cancel' to confirm your business location.`);
      return ack(res);
    }

    // Step 3.5: manual business location
    if (state.step === 3.5) {
      const { knownProvinces, knownCountries } = getValidationLists();
      const countryAliases = { 'united states': 'United States', us: 'United States', canada: 'Canada' };
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
        const canonicalCountry = countryAliases[country.toLowerCase()] || country;
        const isValidProvince = knownProvinces.some(p => p.toLowerCase() === province.toLowerCase());
        const isValidCountry = knownCountries.some(c => c.toLowerCase() === canonicalCountry.toLowerCase());
        if (!isValidProvince || !isValidCountry) return null;
        return { province, country: canonicalCountry };
      };

      const { data, reply: aiReply, confirmed } = await handleInputWithAI(
        normalizedFrom,
        msgRaw,
        'business_location',
        parseFn,
        defaultData
      );

      if (!confirmed) {
        state.invalidAttempts.business_location = (state.invalidAttempts.business_location || 0) + 1;
        if (state.invalidAttempts.business_location > 3) {
          await deletePendingTransactionState(normalizedFrom);
          await saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(normalizedFrom, `Too many invalid location attempts. Onboarding cancelled.`);
          return ack(res);
        }
        await setPendingTransactionState(normalizedFrom, state);
        await sendMessage(
          normalizedFrom,
          aiReply || `Invalid business location. Please use 'State/Province, Country' format (e.g., 'Ontario, Canada').`
        );
        return ack(res);
      }

      state.responses.business_location = data;
      state.invalidAttempts.business_location = 0;
      state.step = 4;
      await setPendingTransactionState(normalizedFrom, state);
      await sendMessage(normalizedFrom, `Please share your email address for your financial dashboard.`);
      return ack(res);
    }

    // Step 4: email
    if (state.step === 4) {
      const email = msgRaw.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        state.invalidAttempts.email = (state.invalidAttempts.email || 0) + 1;
        if (state.invalidAttempts.email > 3) {
          await deletePendingTransactionState(normalizedFrom);
          await saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(normalizedFrom, `Too many invalid attempts. Onboarding cancelled.`);
          return ack(res);
        }
        await setPendingTransactionState(normalizedFrom, state);
        await sendMessage(normalizedFrom, `Please provide a valid email address for your financial dashboard.`);
        return ack(res);
      }

      // Persist captured fields
      const userProfileData = {
        ...(profile || {}),
        user_id: normalizedFrom,
        name: state.responses.name,
        country: state.responses.location.country,
        province: state.responses.location.province,
        business_country: state.responses.business_location.country,
        business_province: state.responses.business_location.province,
        email: email,
        onboarding_in_progress: true,
        onboarding_completed: false,
      };
      await saveUserProfile(userProfileData);
      profile = await getUserProfile(normalizedFrom);

      // OTP + dashboard link
      await generateOTP(normalizedFrom);
      const dashboardUrl = `https://chief-ai-refactored.vercel.app/dashboard/${normalizedFrom}?token=${profile.dashboard_token}`;
      await sendMessage(normalizedFrom, `Your financial dashboard is ready: ${dashboardUrl}`);

      const name = profile.name ? cap(profile.name) : 'there';
      const congratsMessage = `Congratulations ${name}!
You’ve now got a personal CFO — in your pocket — on demand.
Real-time. Data-smart. Built to make your business *make sense*.
📈 We’re talking:
— Auto-tracking your money
— Instant profit breakdowns
— No more “where did it all go?”
— Absolute clarity on every move 💸
Start simple. Try:
🧱 Start job: Start Jack's renovation today
🧾 Expense: Spent $980 at Home Depot for lumber
🚚 Monthly bill: Add monthly truck payment $760
💬 Answers: What do I need to earn this month to pay all my bills?
⏱ Hours: Clock in / Break / Clock out
🛠 Pause job: Pause Jack's renovation to do a repair
✅ Finish job: Finished Jack's renovation
💵 Revenue: Got a $7,500 payment from J
📊 Metrics: How long did Jack's job take and how much did I make?
Your dashboard: ${dashboardUrl}
You'll receive a one-time code via WhatsApp to access it.
Let’s build something great.
— Chief 💼`;
      await sendMessage(normalizedFrom, congratsMessage);

      state.step = 5;
      await setPendingTransactionState(normalizedFrom, state);
      await sendMessage(normalizedFrom, `Please provide your industry (e.g., Construction, Freelancer).`);
      return ack(res);
    }

    // Step 5: industry
    if (state.step === 5) {
      const industry = msgRaw.trim();
      if (!industry || industry.length < 3) {
        state.invalidAttempts.industry = (state.invalidAttempts.industry || 0) + 1;
        if (state.invalidAttempts.industry > 3) {
          await deletePendingTransactionState(normalizedFrom);
          await saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(normalizedFrom, `Too many invalid attempts. Onboarding cancelled.`);
          return ack(res);
        }
        await setPendingTransactionState(normalizedFrom, state);
        await sendMessage(normalizedFrom, `Please provide your industry (e.g., Construction, Freelancer).`);
        return ack(res);
      }

      profile = { ...(profile || {}), user_id: normalizedFrom, industry: cap(industry) };
      state.invalidAttempts.industry = 0;
      state.step = 6;
      await saveUserProfile(profile);
      await setPendingTransactionState(normalizedFrom, state);

      try {
        await sendTemplateMessage(normalizedFrom, 'HX20b1be5490ea39f3730fb9e70d5275df', {});
        return ack(res);
      } catch (error) {
        console.error('[ERROR] Template message failed:', error.message, error.code, error.moreInfo);
        await sendQuickReply(
          normalizedFrom,
          `Great — set industry to ${cap(industry)}. What’s your first money goal? Try "Grow profit by $10,000" or "Pay off $5,000 debt".`,
          ['Grow profit by $10000', 'Pay off $5000 debt']
        );
        return ack(res);
      }
    }

    // Step 6: goal
    if (state.step === 6) {
      const defaultData = { goal: '', amount: 0 };
      const parseFn = input => {
        const m = input.match(/(grow profit by|pay off)\s+\$?(\d+(?:\.\d{1,2})?)/i);
        if (!m) return null;
        const goalType = m[1].toLowerCase();
        const amount = parseFloat(m[2]) * 1000;
        return { goal: `${goalType} $${amount}`, amount };
      };

      const { data, reply: aiReply, confirmed } = await handleInputWithAI(
        normalizedFrom,
        msgRaw,
        'goal',
        parseFn,
        defaultData
      );

      if (!confirmed) {
        state.invalidAttempts.goal = (state.invalidAttempts.goal || 0) + 1;
        if (state.invalidAttempts.goal > 3) {
          await deletePendingTransactionState(normalizedFrom);
          await saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(normalizedFrom, `Too many invalid attempts. Onboarding cancelled.`);
          return ack(res);
        }
        await setPendingTransactionState(normalizedFrom, state);
        await sendQuickReply(
          normalizedFrom,
          aiReply || `Invalid goal. Try "Grow profit by $10000" or "Pay off $5000 debt".`,
          ['Grow profit by $10000', 'Pay off $5000 debt']
        );
        return ack(res);
      }

      // Save goal + complete onboarding
      const nextProfile = {
        ...(profile || {}),
        user_id: normalizedFrom,
        goal: data.goal,
        goal_progress: {
          target: data.goal.includes('debt') ? -data.amount : data.amount,
          current: 0,
        },
        onboarding_in_progress: false,
        onboarding_completed: true,
        current_stage: 'complete',
      };
      await saveUserProfile(nextProfile);
      await deletePendingTransactionState(normalizedFrom);

      const currency = nextProfile.country === 'United States' ? 'USD' : 'CAD';
      await sendMessage(
        normalizedFrom,
        `✅ Goal set: "${data.goal}" (${currency} ${nextProfile.goal_progress.target.toFixed(2)}). You're ready to go! Try: "expense $100 tools" or "create job Roof Repair".`
      );
      return ack(res);
    }

    // Fallback if state is unexpected
    await sendMessage(normalizedFrom, `Unknown onboarding state. Reply 'start onboarding' to begin again.`);
    return ack(res);
  } catch (error) {
    console.error('[ERROR] handleOnboarding failed for', normalizedFrom, ':', error.message, error.code, error.moreInfo);
    const errorReply = await handleError(normalizedFrom, error, 'handleOnboarding', input);
    await sendMessage(normalizedFrom, errorReply || 'An error occurred. Please try again.');
    return ack(res);
  }
}

module.exports = { handleOnboarding };
