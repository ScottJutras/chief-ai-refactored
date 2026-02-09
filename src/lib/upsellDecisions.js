// src/lib/upsellDecisions.js

function shouldShowJobCreatedOrientation({ plan, isFirstJobCreated }) {
  const p = String(plan || 'free').toLowerCase().trim();
  return isFirstJobCreated && p === 'free';
}

function shouldShowCrewUpgradeLine({ plan, isFirstCrewMoment }) {
  const p = String(plan || 'free').toLowerCase().trim();
  return isFirstCrewMoment && (p === 'free' || p === 'starter');
}

module.exports = {
  shouldShowJobCreatedOrientation,
  shouldShowCrewUpgradeLine,
};
