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
const PRO_PRICE_ID = process.env.PRO_PRICE_ID; // price_1RvLTOGgTkTcASeqgPQ1k8MG from .env

// --- utils ---
function normalizePhoneNumber(from = '') {
  const val = String(from || '');
  const noWa = val.startsWith('whatsapp:') ? val.slice('whatsapp:'.length) : val;
  return noWa.replace(/^\+/, '').trim();
}
function cap(s = '') {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Constants
const INVALID_MAX = 3;

const REQUIRED_PROFILE_FIELDS = ['user_id'];

function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}
function isProfileIncomplete(profile) {
  if (!profile) return true;
  return REQUIRED_PROFILE_FIELDS.some(k => !profile[k] || isBlank(profile[k]));
}

/**
 * Multi-step onboarding:
 * 1) name
 * 2) personal location confirm (yes/edit/cancel)
 * 2.5) manual personal location input
 * 3) business location confirm (yes/no/cancel)
 * 3.5) manual business location input
 * 4) email + start 7-day Pro trial (best-effort) + OTP + dashboard link
 * 5) industry
 * 6) goal
 * 7) terms and conditions -> complete
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

    // Reset flow if requested
    const wantsReset = msg === 'reset onboarding' || msg === 'start onboarding';
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
        const { province = 'your state/province', country = 'your country' } = state.detectedLocation || {};
        await sendTemplateMessage(
          normalizedFrom,
          'HX0280df498999848aaff04cc079e16c31',
          { '1': state.responses.name, '2': province, '3': country }
        );
        return ack(res);
      } catch (error) {
        console.error('[ERROR] Template message failed, falling back to quick reply:', error.message, error.code, error.moreInfo);
        await sendQuickReply(
          normalizedFrom,
          `Hi ${state.responses.name}! I detected you’re in ${state.detectedLocation?.province || 'your state/province'}, ${state.detectedLocation?.country || 'your country'}. Is that correct?`,
          ['yes', 'edit', 'cancel']
        );
        return ack(res);
      }
    }

    // Step 2: confirm detected personal location
    if (state.step === 2) {
      if (/^(y|ya|yep|yeah|yes)$/i.test(msg)) {
        state.responses.location = state.detectedLocation;
        state.step = 3;
        await setPendingTransactionState(normalizedFrom, state);

        try {
          await sendTemplateMessage(normalizedFrom, 'HXa885f78d7654642672bfccfae98d57cb', {});
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
      if (/^edit$/i.test(msg)) {
        state.step = 2.5;
        await setPendingTransactionState(normalizedFrom, state);
        await sendMessage(normalizedFrom, `Please provide your State/Province, Country (e.g., 'Ontario, Canada').`);
        return ack(res);
      }
      if (/^cancel$/i.test(msg)) {
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
        if (state.invalidAttempts.location >= INVALID_MAX) {
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
        await sendTemplateMessage(normalizedFrom, 'HXa885f78d7654642672bfccfae98d57cb', {});
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
      if (/^(y|ya|yep|yeah|yes)$/i.test(msg)) {
        state.responses.business_location = state.responses.location;
        state.step = 4;
        await setPendingTransactionState(normalizedFrom, state);
        await sendMessage(normalizedFrom, `Please share your email address for your financial dashboard.`);
        return ack(res);
      }
      if (/^(n|no|nope)$/i.test(msg)) {
        state.step = 3.5;
        await setPendingTransactionState(normalizedFrom, state);
        await sendMessage(normalizedFrom, `Please provide your business's registered State/Province, Country (e.g., 'Ontario, Canada').`);
        return ack(res);
      }
      if (/^cancel$/i.test(msg)) {
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
        if (state.invalidAttempts.business_location >= INVALID_MAX) {
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

    // Step 4: email + start 7-day Pro trial (best-effort) + OTP + dashboard link
    if (state.step === 4) {
      const email = msgRaw.trim().toLowerCase(); // normalize to avoid dup customers
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        state.invalidAttempts.email = (state.invalidAttempts.email || 0) + 1;
        if (state.invalidAttempts.email >= INVALID_MAX) {
          await deletePendingTransactionState(normalizedFrom);
          await saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(normalizedFrom, `Too many invalid attempts. Onboarding cancelled.`);
          return ack(res);
        }
        await setPendingTransactionState(normalizedFrom, state);
        await sendMessage(normalizedFrom, `Please provide a valid email address for your financial dashboard.`);
        return ack(res);
      }

      // Try to create/update Stripe customer & 7-day trial (non-blocking)
      let stripe_customer_id = profile?.stripe_customer_id || null;
      let stripe_subscription_id = profile?.stripe_subscription_id || null;
      let trial_start = null;
      let trial_end = null;

      if (process.env.STRIPE_SECRET_KEY && PRO_PRICE_ID) {
        try {
          // Create customer if missing
          if (!stripe_customer_id) {
            const customer = await stripe.customers.create(
              {
                email,
                phone: `+${normalizedFrom}`,
                metadata: { user_id: normalizedFrom },
              },
              { idempotencyKey: `cust_${normalizedFrom}` }
            );
            stripe_customer_id = customer.id;
          }

          // Create trialing subscription if missing
          if (!stripe_subscription_id) {
            const sub = await stripe.subscriptions.create(
              {
                customer: stripe_customer_id,
                items: [{ price: PRO_PRICE_ID }],
                trial_period_days: 7,
                payment_behavior: 'default_incomplete',
                trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
                metadata: { user_id: normalizedFrom, plan: 'pro_trial' },
              },
              { idempotencyKey: `sub_${normalizedFrom}` }
            );
            stripe_subscription_id = sub.id;
            // convert to ISO strings for DB safety
            if (sub.trial_start) trial_start = new Date(sub.trial_start * 1000).toISOString();
            if (sub.trial_end) trial_end = new Date(sub.trial_end * 1000).toISOString();
          }
        } catch (e) {
          console.warn('[TRIAL] Stripe trial setup failed (continuing onboarding):', e.message);
        }
      } else {
        console.warn('[TRIAL] Missing STRIPE_SECRET_KEY or PRO_PRICE_ID; skipping trial setup.');
      }

      // Persist captured fields (don’t block if Stripe was skipped/failed)
      const loc = state.responses.location || state.detectedLocation || { province: '', country: '' };
      const bloc = state.responses.business_location || loc;
      const userProfileData = {
        ...(profile || {}),
        user_id: normalizedFrom,
        name: state.responses.name,
        country: loc.country,
        province: loc.province,
        business_country: bloc.country,
        business_province: bloc.province,
        email,
        stripe_customer_id: stripe_customer_id || null,
        stripe_subscription_id: stripe_subscription_id || null,
        subscription_tier: stripe_subscription_id ? 'pro' : (profile?.subscription_tier || 'basic'),
        paid_tier: stripe_subscription_id ? 'trial' : (profile?.paid_tier || 'free'),
        trial_start: trial_start || null,
        trial_end: trial_end || null,
        current_stage: stripe_subscription_id ? 'trial' : (profile?.current_stage || 'onboarding'),
        onboarding_in_progress: true,
        onboarding_completed: false,
      };
      await saveUserProfile(userProfileData);

      // OTP + dashboard link (fix race: get token from generator or fresh profile)
      const otpToken = await generateOTP(normalizedFrom);
      const fresh = await getUserProfile(normalizedFrom);
      profile = fresh || userProfileData;
      const token = otpToken || fresh?.dashboard_token || null;
      const dashboardUrl = `https://chief-ai-refactored.vercel.app/dashboard/${normalizedFrom}${token ? `?token=${encodeURIComponent(token)}` : ''}`;

      // Send link first (then the long message)
      await sendMessage(normalizedFrom, `Your financial dashboard is ready: ${dashboardUrl}`);

      const name = profile.name ? cap(profile.name) : 'there';
      const congratsMessage = `Congratulations ${name}!
You’ve now got a personal CFO — in your pocket — on demand.
${profile.paid_tier === 'trial' ? 'You’re on a 7-day free trial of the Pro plan — explore all features!' : 'You can explore core features right away!'}
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
You'll receive a one-time code via WhatsApp to access it.
Let’s build something great.
— Chief 💼`;
      await sendMessage(normalizedFrom, congratsMessage);

      state.step = 5;
      await setPendingTransactionState(normalizedFrom, state);
      await sendQuickReply(
        normalizedFrom,
        `What industry is your business in? (e.g., Construction, Freelancer)`,
        ['Construction', 'Freelancer', 'Other']
      );
      return ack(res);
    }

    // Step 5: industry
    if (state.step === 5) {
      const industry = msgRaw.trim();
      if (!industry || industry.length < 3) {
        state.invalidAttempts.industry = (state.invalidAttempts.industry || 0) + 1;
        if (state.invalidAttempts.industry >= INVALID_MAX) {
          await deletePendingTransactionState(normalizedFrom);
          await saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(normalizedFrom, `Too many invalid attempts. Onboarding cancelled.`);
          return ack(res);
        }
        await setPendingTransactionState(normalizedFrom, state);
        await sendQuickReply(
          normalizedFrom,
          `Please provide your industry (e.g., Construction, Freelancer).`,
          ['Construction', 'Freelancer', 'Other']
        );
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
          `Great — set industry to ${cap(industry)}. What’s your financial goal for your business? For example, you might want to save for a big purchase, pay off debt, or grow your profits.`,
          ['Save for a purchase', 'Pay off debt', 'Grow profits']
        );
        return ack(res);
      }
    }

    // Step 6: goal
    if (state.step === 6) {
      const defaultData = { goal: msgRaw, amount: null, timeframe: null };
      const parseFn = input => {
        const amountMatch = input.match(/\$?([\d,]+(?:\.\d{1,2})?)/i);
        const timeframeMatch = input.match(/(in|within|by)\s+(\d+\s*(month|year|week)s?)/i);
        return {
          goal: input.trim(),
          amount: amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null,
          timeframe: timeframeMatch ? timeframeMatch[2] : null,
        };
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
        if (state.invalidAttempts.goal >= INVALID_MAX) {
          await deletePendingTransactionState(normalizedFrom);
          await saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(normalizedFrom, `Too many invalid attempts. Onboarding cancelled.`);
          return ack(res);
        }
        await setPendingTransactionState(normalizedFrom, state);
        await sendQuickReply(
          normalizedFrom,
          aiReply || `Please share your financial goal. For example, you might want to save for a big purchase, pay off debt, or grow your profits.`,
          ['Save for a purchase', 'Pay off debt', 'Grow profits']
        );
        return ack(res);
      }

      const isDebt = data.goal.toLowerCase().startsWith('pay off');
      profile = {
        ...(profile || {}),
        user_id: normalizedFrom,
        goal: data.goal,
        goal_progress: data.amount
          ? {
              target: isDebt ? -data.amount : data.amount,
              current: 0,
            }
          : null,
        goal_context: {
          raw_goal: data.goal,
          amount: data.amount,
          timeframe: data.timeframe,
        },
        onboarding_in_progress: true,
        onboarding_completed: false,
      };
      await saveUserProfile(profile);
      state.step = 7;
      await setPendingTransactionState(normalizedFrom, state);

      await sendQuickReply(
        normalizedFrom,
        `That’s a fantastic goal: "${data.goal}". To continue, please agree to our Terms and Conditions and User Agreement: https://chief-ai-refactored.vercel.app/terms-and-conditions. Reply 'agree' to proceed or 'cancel' to stop.`,
        ['agree', 'cancel']
      );
      return ack(res);
    }

    // Step 7: terms and conditions
    if (state.step === 7) {
      if (/^\s*(i\s+agree|agree|accept|accepted|yes|yep|yeah)\b/i.test(msg)) {
        const nextProfile = {
          ...(profile || {}),
          user_id: normalizedFrom,
          onboarding_in_progress: false,
          onboarding_completed: true,
          current_stage: 'complete',
        };
        await saveUserProfile(nextProfile);
        await deletePendingTransactionState(normalizedFrom);

        const trialEndStr = profile?.trial_end
          ? new Date(profile.trial_end).toLocaleDateString()
          : null;

        await sendMessage(
          normalizedFrom,
          `✅ Terms accepted! ${trialEndStr ? `Your 7-day Pro trial runs until ${trialEndStr}. ` : ''}You're ready to go. Try: "expense $100 tools" or "create job Roof Repair".`
        );
        return ack(res);
      }
      if (/^cancel$/i.test(msg)) {
        await deletePendingTransactionState(normalizedFrom);
        await saveUserProfile({ ...profile, onboarding_in_progress: false });
        await sendMessage(normalizedFrom, `Onboarding cancelled. Reply 'start onboarding' to begin again.`);
        return ack(res);
      }
      await sendQuickReply(
        normalizedFrom,
        `Please reply with 'agree' to accept the Terms and Conditions or 'cancel' to stop.`,
        ['agree', 'cancel']
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
