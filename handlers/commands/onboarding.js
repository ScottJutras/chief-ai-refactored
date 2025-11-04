// handlers/onboarding.js
// ---------------------------------------------------------------
// Multi‑step onboarding – name → location → business location →
// email + 7‑day Pro trial + OTP + dashboard link → industry →
// timezone → goal → terms → complete.
// ---------------------------------------------------------------
const pg = require('../../services/postgres');
const { releaseLock } = require('../../middleware/lock');
const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState,
} = require('../../utils/stateManager');
const { sendTemplateMessage, sendQuickReply, sendMessage } = require('../../services/twilio');
const { getValidationLists, detectLocation } = require('../../utils/validateLocation');
const { resolveTimezone, isValidIanaTz, suggestTimezone } = require('../../utils/timezones');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const PRO_PRICE_ID = process.env.PRO_PRICE_ID;

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------
const normalizePhone = (raw = '') =>
  String(raw || '').replace(/^whatsapp:/i, '').replace(/\D/g, '');

const cap = (s = '') =>
  s
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

const INVALID_MAX = 3;
const REQUIRED_FIELDS = ['user_id'];

/** Safe lock release + audit */
async function safeCleanup(req) {
  const key = `lock:${req.ownerId || req.from || 'GLOBAL'}`;
  try { await releaseLock(key); } catch {}
}

/** TwiML helper */
function twiml(res, body) {
  return res
    .status(200)
    .type('application/xml')
    .send(`<Response><Message>${body}</Message></Response>`);
}

// -----------------------------------------------------------------
// Main handler – returns true when it responded
// -----------------------------------------------------------------
module.exports = async function handleOnboarding(
  from,
  input,
  userProfile,
  ownerId,
  res
) {
  const raw = String(input || '').trim();
  const lc = raw.toLowerCase();
  const fromNorm = normalizePhone(from);

  try {
    // -------------------------------------------------
    // 1. Fresh profile + bootstrap if missing
    // -------------------------------------------------
    let profile = await pg.getUserProfile(fromNorm);
    if (!profile) {
      profile = await pg.createUserProfile({
        user_id: fromNorm,
        ownerId: fromNorm,
        onboarding_in_progress: true,
      });
    }

    // -------------------------------------------------
    // 2. Reset flow if requested
    // -------------------------------------------------
    if (/^reset onboarding|start onboarding$/i.test(lc)) {
      await deletePendingTransactionState(fromNorm);
      profile = { ...profile, onboarding_in_progress: true, onboarding_completed: false };
      await pg.saveUserProfile(profile);
      const state = {
        step: 1,
        responses: {},
        detectedLocation: detectLocation(fromNorm),
        invalidAttempts: {},
      };
      await setPendingTransactionState(fromNorm, state);
      await sendMessage(fromNorm, 'Welcome to Chief AI! Please reply with your full name.');
      await safeCleanup({ ownerId: fromNorm });
      return true;
    }

    // -------------------------------------------------
    // 3. Load / create state
    // -------------------------------------------------
    let state = await getPendingTransactionState(fromNorm);
    if (!state) {
      state = {
        step: 1,
        responses: {},
        detectedLocation: detectLocation(fromNorm),
        invalidAttempts: {},
      };
      await setPendingTransactionState(fromNorm, state);
      await sendMessage(fromNorm, 'Welcome to Chief AI! Please reply with your full name.');
      await safeCleanup({ ownerId: fromNorm });
      return true;
    }

    // -------------------------------------------------
    // 4. STEP MACHINE
    // -------------------------------------------------
    // ---- Step 1: name ----
    if (state.step === 1) {
      const name = raw.trim();
      if (!name || name.length < 2) {
        await sendMessage(fromNorm, 'Please provide your full name to continue.');
        return true;
      }
      state.responses.name = cap(name);
      state.step = 2;
      await setPendingTransactionState(fromNorm, state);

      const { knownProvinces, knownCountries } = getValidationLists();
      const loc = state.detectedLocation || {};
      const provinceOk = loc.province && knownProvinces.some((p) => p.toLowerCase() === loc.province.toLowerCase());
      const countryOk = loc.country && knownCountries.some((c) => c.toLowerCase() === loc.country.toLowerCase());

      if (provinceOk && countryOk) {
        try {
          await sendTemplateMessage(
            fromNorm,
            'HX0280df498999848aaff04cc079e16c31', // location confirm
            { '1': loc.province, '2': loc.country }
          );
          return true;
        } catch {
          await sendQuickReply(
            fromNorm,
            `Hi ${state.responses.name}! Is this your location?\n${loc.province}, ${loc.country}`,
            ['yes', 'edit', 'cancel']
          );
          return true;
        }
      }

      await sendQuickReply(
        fromNorm,
        `Hi ${state.responses.name}! Please provide your State/Province, Country (e.g., "Ontario, Canada").`,
        ['edit', 'cancel']
      );
      return true;
    }

    // ---- Step 2: personal location confirm ----
    if (state.step === 2) {
      if (/^y(es)?$/i.test(lc)) {
        state.responses.location = state.detectedLocation;
        state.step = 3;
        await setPendingTransactionState(fromNorm, state);
        await sendTemplateMessage(fromNorm, 'HXa885f78d7654642672bfccfae98d57cb', {}); // business same?
        return true;
      }
      if (/^edit$/i.test(lc)) {
        state.step = 2.5;
        await setPendingTransactionState(fromNorm, state);
        await sendMessage(fromNorm, `Please provide your State/Province, Country (e.g., "Ontario, Canada").`);
        return true;
      }
      if (/^cancel$/i.test(lc)) {
        await deletePendingTransactionState(fromNorm);
        await pg.saveUserProfile({ ...profile, onboarding_in_progress: false });
        await sendMessage(fromNorm, `Onboarding cancelled. Reply "start onboarding" to begin again.`);
        return true;
      }
      await sendMessage(fromNorm, `Please reply with 'yes', 'edit', or 'cancel'.`);
      return true;
    }

    // ---- Step 2.5: manual personal location ----
    if (state.step === 2.5) {
      const { knownProvinces, knownCountries } = getValidationLists();
      const parts = raw.split(',').map((s) => s.trim());
      const province = parts[0] || '';
      const country = parts[1] || '';
      const countryAliases = { us: 'United States', usa: 'United States', canada: 'Canada' };
      const canonical = countryAliases[country.toLowerCase()] || country;

      const validProvince = knownProvinces.some((p) => p.toLowerCase() === province.toLowerCase());
      const validCountry = knownCountries.some((c) => c.toLowerCase() === canonical.toLowerCase());

      if (!validProvince || !validCountry) {
        state.invalidAttempts.location = (state.invalidAttempts.location || 0) + 1;
        if (state.invalidAttempts.location >= INVALID_MAX) {
          await deletePendingTransactionState(fromNorm);
          await pg.saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(fromNorm, `Too many invalid attempts. Onboarding cancelled.`);
          return true;
        }
        await setPendingTransactionState(fromNorm, state);
        await sendMessage(fromNorm, `Invalid location. Use "State/Province, Country" (e.g., "Ontario, Canada").`);
        return true;
      }

      state.responses.location = { province, country: canonical };
      state.step = 3;
      await setPendingTransactionState(fromNorm, state);
      await sendTemplateMessage(fromNorm, 'HXa885f78d7654642672bfccfae98d57cb', {});
      return true;
    }

    // ---- Step 3: business location confirm ----
    if (state.step === 3) {
      if (/^y(es)?$/i.test(lc)) {
        state.responses.business_location = state.responses.location;
        state.step = 4;
        await setPendingTransactionState(fromNorm, state);
        await sendMessage(fromNorm, `Please share your email address for your financial dashboard.`);
        return true;
      }
      if (/^no?$/i.test(lc)) {
        state.step = 3.5;
        await setPendingTransactionState(fromNorm, state);
        await sendMessage(fromNorm, `Please provide your business's registered State/Province, Country.`);
        return true;
      }
      if (/^cancel$/i.test(lc)) {
        await deletePendingTransactionState(fromNorm);
        await pg.saveUserProfile({ ...profile, onboarding_in_progress: false });
        await sendMessage(fromNorm, `Onboarding cancelled.`);
        return true;
      }
      await sendMessage(fromNorm, `Please reply with 'yes', 'no', or 'cancel'.`);
      return true;
    }

    // ---- Step 3.5: manual business location ----
    if (state.step === 3.5) {
      const parts = raw.split(',').map((s) => s.trim());
      const province = parts[0] || '';
      const country = parts[1] || '';
      const { knownProvinces, knownCountries } = getValidationLists();
      const canonical = { us: 'United States', usa: 'United States', canada: 'Canada' }[country.toLowerCase()] || country;

      const validProvince = knownProvinces.some((p) => p.toLowerCase() === province.toLowerCase());
      const validCountry = knownCountries.some((c) => c.toLowerCase() === canonical.toLowerCase());

      if (!validProvince || !validCountry) {
        state.invalidAttempts.business_location = (state.invalidAttempts.business_location || 0) + 1;
        if (state.invalidAttempts.business_location >= INVALID_MAX) {
          await deletePendingTransactionState(fromNorm);
          await pg.saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(fromNorm, `Too many invalid attempts. Onboarding cancelled.`);
          return true;
        }
        await setPendingTransactionState(fromNorm, state);
        await sendMessage(fromNorm, `Invalid business location. Use "State/Province, Country".`);
        return true;
      }

      state.responses.business_location = { province, country: canonical };
      state.step = 4;
      await setPendingTransactionState(fromNorm, state);
      await sendMessage(fromNorm, `Please share your email address for your financial dashboard.`);
      return true;
    }

    // ---- Step 4: email + Stripe trial + OTP + dashboard ----
    if (state.step === 4) {
      const email = raw.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        state.invalidAttempts.email = (state.invalidAttempts.email || 0) + 1;
        if (state.invalidAttempts.email >= INVALID_MAX) {
          await deletePendingTransactionState(fromNorm);
          await pg.saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(fromNorm, `Too many invalid attempts. Onboarding cancelled.`);
          return true;
        }
        await setPendingTransactionState(fromNorm, state);
        await sendMessage(fromNorm, `Please provide a valid email address.`);
        return true;
      }

      // ---- Stripe 7‑day Pro trial (best‑effort) ----
      let stripe_customer_id = profile?.stripe_customer_id;
      let stripe_subscription_id = profile?.stripe_subscription_id;
      let trial_start = null;
      let trial_end = null;
      if (process.env.STRIPE_SECRET_KEY && PRO_PRICE_ID) {
        try {
          if (!stripe_customer_id) {
            const cust = await stripe.customers.create({
              email,
              phone: `+${fromNorm}`,
              metadata: { user_id: fromNorm },
            });
            stripe_customer_id = cust.id;
          }
          if (!stripe_subscription_id) {
            const sub = await stripe.subscriptions.create({
              customer: stripe_customer_id,
              items: [{ price: PRO_PRICE_ID }],
              trial_period_days: 7,
              payment_behavior: 'default_incomplete',
              metadata: { user_id: fromNorm },
            });
            stripe_subscription_id = sub.id;
            trial_start = sub.trial_start ? new Date(sub.trial_start * 1000).toISOString() : null;
            trial_end = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
          }
        } catch (e) {
          console.warn('[onboarding] Stripe trial failed (continuing):', e.message);
        }
      }

      // ---- Persist captured data ----
      const loc = state.responses.location || state.detectedLocation || { province: '', country: '' };
      const bloc = state.responses.business_location || loc;
      const updated = {
        ...profile,
        user_id: fromNorm,
        name: state.responses.name,
        country: loc.country,
        province: loc.province,
        business_country: bloc.country,
        business_province: bloc.province,
        email,
        stripe_customer_id,
        stripe_subscription_id,
        subscription_tier: stripe_subscription_id ? 'pro' : (profile?.subscription_tier || 'basic'),
        trial_start,
        trial_end,
        onboarding_in_progress: true,
        onboarding_completed: false,
      };
      await pg.saveUserProfile(updated);

      // ---- OTP + dashboard link ----
      const otp = await pg.generateOTP(fromNorm);
      const fresh = await pg.getUserProfile(fromNorm);
      const token = otp || fresh?.dashboard_token || null;
      const dashboardUrl = `https://chief-ai-refactored.vercel.app/dashboard/${fromNorm}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      await sendMessage(fromNorm, `Your financial dashboard: ${dashboardUrl}`);

      const congrats = `Congratulations ${cap(state.responses.name)}!\nYou’re on a 7-day Pro trial. Explore all features!\nStart with:\n• "expense $100 tools"\n• "create job Roof Repair"`;
      await sendMessage(fromNorm, congrats);

      state.step = 5;
      await setPendingTransactionState(fromNorm, state);
      await sendQuickReply(
        fromNorm,
        `What industry is your business in?`,
        ['Construction', 'Freelancer', 'Other']
      );
      return true;
    }

    // ---- Step 5: industry ----
    if (state.step === 5) {
      const industry = raw.trim();
      if (!industry || industry.length < 3) {
        state.invalidAttempts.industry = (state.invalidAttempts.industry || 0) + 1;
        if (state.invalidAttempts.industry >= INVALID_MAX) {
          await deletePendingTransactionState(fromNorm);
          await pg.saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(fromNorm, `Too many invalid attempts. Onboarding cancelled.`);
          return true;
        }
        await setPendingTransactionState(fromNorm, state);
        await sendQuickReply(fromNorm, `Please provide your industry.`, ['Construction', 'Freelancer', 'Other']);
        return true;
      }
      profile = { ...profile, user_id: fromNorm, industry: cap(industry) };
      state.step = 6;
      await pg.saveUserProfile(profile);
      await setPendingTransactionState(fromNorm, state);

      const loc = state.responses.location || state.detectedLocation || { province: '', country: '' };
      const suggested = state.detectedLocation?.timezone || suggestTimezone(loc.country, loc.province) || 'UTC';
      await sendQuickReply(
        fromNorm,
        `Set industry to ${cap(industry)}. What’s your timezone? Suggested: ${suggested}`,
        [suggested, 'Other']
      );
      return true;
    }

    // ---- Step 6: timezone ----
    if (state.step === 6) {
      const candidate = raw.trim();
      if (/^other$/i.test(candidate)) {
        await sendMessage(fromNorm, `Reply with a city (e.g., "Toronto") or IANA timezone (e.g., "America/Toronto").`);
        return true;
      }
      let tz = resolveTimezone(candidate);
      if (!tz) {
        const loc = state.responses.location || state.detectedLocation || { province: '', country: '' };
        tz = suggestTimezone(loc.country, loc.province) || null;
      }
      if (!tz || !isValidIanaTz(tz)) {
        state.invalidAttempts.timezone = (state.invalidAttempts.timezone || 0) + 1;
        if (state.invalidAttempts.timezone >= INVALID_MAX) {
          await deletePendingTransactionState(fromNorm);
          await pg.saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(fromNorm, `Too many invalid attempts. Onboarding cancelled.`);
          return true;
        }
        await setPendingTransactionState(fromNorm, state);
        await sendQuickReply(fromNorm, `Invalid timezone. Try a city or IANA name.`, ['America/Toronto', 'America/Vancouver', 'Other']);
        return true;
      }
      profile = { ...profile, user_id: fromNorm, timezone: tz };
      state.step = 7;
      await pg.saveUserProfile(profile);
      await setPendingTransactionState(fromNorm, state);
      await sendQuickReply(
        fromNorm,
        `Timezone set to ${tz}. What’s your financial goal?`,
        ['Save for a purchase', 'Pay off debt', 'Grow profits']
      );
      return true;
    }

    // ---- Step 7: goal ----
    if (state.step === 7) {
      const goal = raw.trim();
      if (!goal) {
        state.invalidAttempts.goal = (state.invalidAttempts.goal || 0) + 1;
        if (state.invalidAttempts.goal >= INVALID_MAX) {
          await deletePendingTransactionState(fromNorm);
          await pg.saveUserProfile({ ...profile, onboarding_in_progress: false });
          await sendMessage(fromNorm, `Too many invalid attempts. Onboarding cancelled.`);
          return true;
        }
        await setPendingTransactionState(fromNorm, state);
        await sendQuickReply(fromNorm, `Please share your financial goal.`, ['Save for a purchase', 'Pay off debt', 'Grow profits']);
        return true;
      }
      profile = { ...profile, user_id: fromNorm, goal };
      state.step = 8;
      await pg.saveUserProfile(profile);
      await setPendingTransactionState(fromNorm, state);
      await sendQuickReply(
        fromNorm,
        `Goal set: "${goal}". Agree to Terms: https://chief-ai-refactored.vercel.app/terms-and-conditions`,
        ['agree', 'cancel']
      );
      return true;
    }

    // ---- Step 8: terms ----
    if (state.step === 8) {
      if (/^agree$/i.test(lc)) {
        const final = {
          ...profile,
          user_id: fromNorm,
          onboarding_in_progress: false,
          onboarding_completed: true,
        };
        await pg.saveUserProfile(final);
        await deletePendingTransactionState(fromNorm);
        await sendMessage(
          fromNorm,
          `Onboarding complete! Try "expense $100 tools" or "create job Roof Repair".`
        );
        await safeCleanup({ ownerId: fromNorm });
        return true;
      }
      if (/^cancel$/i.test(lc)) {
        await deletePendingTransactionState(fromNorm);
        await pg.saveUserProfile({ ...profile, onboarding_in_progress: false });
        await sendMessage(fromNorm, `Onboarding cancelled.`);
        await safeCleanup({ ownerId: fromNorm });
        return true;
      }
      await sendQuickReply(fromNorm, `Please reply 'agree' or 'cancel'.`, ['agree', 'cancel']);
      return true;
    }

    // -------------------------------------------------
    // 5. Fallback
    // -------------------------------------------------
    await sendMessage(fromNorm, `Unknown step. Reply "start onboarding" to restart.`);
    return true;
  } catch (err) {
    console.error('[onboarding] error:', err?.message);
    await sendMessage(fromNorm, `Something went wrong. Try again.`);
    await safeCleanup({ ownerId: fromNorm });
    return true;
  }
};