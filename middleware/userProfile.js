const { getUserProfile, getOwnerProfile, createUserProfile } = require('../services/postgres');
const { normalizePhoneNumber } = require('../utils/lockManager');

async function userProfileMiddleware(req, res, next) {
  const rawFrom = req.body.From || '';
  const from = normalizePhoneNumber(rawFrom);
  console.log('[DEBUG] userProfileMiddleware invoked:', { from, timestamp: new Date().toISOString() });

  try {
    let userProfile = await getUserProfile(from);
    if (!userProfile) {
      userProfile = await createUserProfile({ phone: from, ownerId: from });
      console.log('[DEBUG] Created new user profile for', from);
    }

    const ownerId = normalizePhoneNumber(userProfile.owner_id || from);
    const ownerProfile = await getOwnerProfile(ownerId);
    req.userProfile = userProfile;
    req.ownerId = ownerId;
    req.ownerProfile = ownerProfile || userProfile;
    req.isOwner = userProfile.user_id === ownerId;

    console.log('[DEBUG] userProfileMiddleware result:', {
      userProfile: {
        user_id: userProfile.user_id,
        name: userProfile.name,
        country: userProfile.country,
        province: userProfile.province,
        business_country: userProfile.business_country,
        business_province: userProfile.business_province,
        email: userProfile.email,
        spreadsheet_id: userProfile.spreadsheet_id,
        onboarding_in_progress: userProfile.onboarding_in_progress,
        onboarding_completed: userProfile.onboarding_completed,
        subscription_tier: userProfile.subscription_tier,
        trial_start: userProfile.trial_start,
        trial_end: userProfile.trial_end,
        token_usage: userProfile.token_usage,
        created_at: userProfile.created_at,
        dashboard_token: userProfile.dashboard_token,
        otp: userProfile.otp,
        otp_expiry: userProfile.otp_expiry,
        team_members: userProfile.team_members,
        is_team_member: userProfile.is_team_member,
        owner_id: userProfile.owner_id,
        updated_at: userProfile.updated_at,
        goal: userProfile.goal,
        goal_progress: userProfile.goal_progress,
        industry: userProfile.industry,
        current_stage: userProfile.current_stage,
        paid_tier: userProfile.paid_tier,
        stripe_customer_id: userProfile.stripe_customer_id,
        reminder_needed: userProfile.reminder_needed,
        last_otp: userProfile.last_otp,
        last_otp_time: userProfile.last_otp_time,
        fiscal_year_start: userProfile.fiscal_year_start,
        fiscal_year_end: userProfile.fiscal_year_end,
        historical_data_years: userProfile.historical_data_years,
        recap_time_pref: userProfile.recap_time_pref,
        training_completed: userProfile.training_completed,
        team: userProfile.team,
        stripe_subscription_id: userProfile.stripe_subscription_id,
        historical_parsing_purchased: userProfile.historical_parsing_purchased
      }
    });

    next();
  } catch (err) {
    console.error('[ERROR] userProfileMiddleware failed:', err.message);
    next(err);
  }
}

module.exports = { userProfileMiddleware };