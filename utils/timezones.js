// utils/timezones.js

function isValidIanaTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format();
    return true;
  } catch {
    return false;
  }
}

/** Common city -> IANA */
const CITY_MAP = {
  // Canada
  toronto: 'America/Toronto',
  london: 'America/Toronto',
  ottawa: 'America/Toronto',
  montreal: 'America/Toronto',
  vancouver: 'America/Vancouver',
  calgary: 'America/Edmonton',
  edmonton: 'America/Edmonton',
  winnipeg: 'America/Winnipeg',
  halifax: 'America/Halifax',
  'st. johns': 'America/St_Johns',

  // U.S.
  'new york': 'America/New_York',
  nyc: 'America/New_York',
  boston: 'America/New_York',
  miami: 'America/New_York',
  atlanta: 'America/New_York',
  chicago: 'America/Chicago',
  detroit: 'America/Detroit',
  dallas: 'America/Chicago',
  houston: 'America/Chicago',
  austin: 'America/Chicago',
  nashville: 'America/Chicago',
  memphis: 'America/Chicago',
  minneapolis: 'America/Chicago',
  denver: 'America/Denver',
  'salt lake city': 'America/Denver',
  albuquerque: 'America/Denver',
  boise: 'America/Boise',
  phoenix: 'America/Phoenix',
  seattle: 'America/Los_Angeles',
  portland: 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  'san diego': 'America/Los_Angeles',
  'las vegas': 'America/Los_Angeles',
  'los angeles': 'America/Los_Angeles',
  anchorage: 'America/Anchorage',
  honolulu: 'Pacific/Honolulu',
  sanjuan: 'America/Puerto_Rico'
};

/** U.S. state/territory -> IANA (single best fit per state) */
const US_STATE_TZ = {
  alabama: 'America/Chicago',
  alaska: 'America/Anchorage',
  arizona: 'America/Phoenix',
  arkansas: 'America/Chicago',
  california: 'America/Los_Angeles',
  colorado: 'America/Denver',
  connecticut: 'America/New_York',
  delaware: 'America/New_York',
  'district of columbia': 'America/New_York',
  florida: 'America/New_York', // (Panhandle has CST; see suggestTimezone areaCode hint)
  georgia: 'America/New_York',
  hawaii: 'Pacific/Honolulu',
  idaho: 'America/Boise',
  illinois: 'America/Chicago',
  indiana: 'America/Indiana/Indianapolis',
  iowa: 'America/Chicago',
  kansas: 'America/Chicago',
  kentucky: 'America/New_York',
  louisiana: 'America/Chicago',
  maine: 'America/New_York',
  maryland: 'America/New_York',
  massachusetts: 'America/New_York',
  michigan: 'America/Detroit',
  minnesota: 'America/Chicago',
  mississippi: 'America/Chicago',
  missouri: 'America/Chicago',
  montana: 'America/Denver',
  nebraska: 'America/Chicago',
  nevada: 'America/Los_Angeles',
  'new hampshire': 'America/New_York',
  'new jersey': 'America/New_York',
  'new mexico': 'America/Denver',
  'new york': 'America/New_York',
  'north carolina': 'America/New_York',
  'north dakota': 'America/Chicago',
  ohio: 'America/New_York',
  oklahoma: 'America/Chicago',
  oregon: 'America/Los_Angeles',
  pennsylvania: 'America/New_York',
  'rhode island': 'America/New_York',
  'south carolina': 'America/New_York',
  'south dakota': 'America/Chicago',
  tennessee: 'America/Chicago',
  texas: 'America/Chicago',
  utah: 'America/Denver',
  vermont: 'America/New_York',
  virginia: 'America/New_York',
  washington: 'America/Los_Angeles',
  'west virginia': 'America/New_York',
  wisconsin: 'America/Chicago',
  wyoming: 'America/Denver',
  'puerto rico': 'America/Puerto_Rico'
};

/** U.S. postal abbreviation -> lowercase state key */
const US_ABBR = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado',
  CT: 'connecticut', DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia',
  HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky',
  LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota',
  MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire',
  NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota',
  OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina',
  SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia',
  WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', PR: 'puerto rico'
};

/** Canada province/territory (and abbreviations) -> IANA */
const CA_PROV_TZ = {
  ontario: 'America/Toronto', on: 'America/Toronto',
  quebec: 'America/Toronto', qc: 'America/Toronto',
  'british columbia': 'America/Vancouver', bc: 'America/Vancouver',
  alberta: 'America/Edmonton', ab: 'America/Edmonton',
  manitoba: 'America/Winnipeg', mb: 'America/Winnipeg',
  saskatchewan: 'America/Regina', sk: 'America/Regina',
  'new brunswick': 'America/Moncton', nb: 'America/Moncton',
  'nova scotia': 'America/Halifax', ns: 'America/Halifax',
  'prince edward island': 'America/Halifax', pe: 'America/Halifax',
  'newfoundland and labrador': 'America/St_Johns', nl: 'America/St_Johns',
  yukon: 'America/Whitehorse', yt: 'America/Whitehorse',
  'northwest territories': 'America/Yellowknife', nt: 'America/Yellowknife',
  nunavut: 'America/Iqaluit', nu: 'America/Iqaluit'
};

function resolveTimezone(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (isValidIanaTz(raw)) return raw;

  const lc = raw.toLowerCase();
  if (CITY_MAP[lc]) return CITY_MAP[lc];
  if (US_STATE_TZ[lc]) return US_STATE_TZ[lc];
  if (US_ABBR[lc.toUpperCase()]) return US_STATE_TZ[US_ABBR[lc.toUpperCase()]];
  if (CA_PROV_TZ[lc]) return CA_PROV_TZ[lc];

  return null;
}

/**
 * Suggest a timezone from country/region, optionally using areaCode
 * for corner cases like Florida Panhandle (CST, 850).
 */
function suggestTimezone(country, region, areaCode) {
  const c = (country || '').toLowerCase();
  const r = (region || '').toLowerCase();

  // Florida Panhandle example
  if (c === 'united states' && r === 'florida' && areaCode === '850') {
    return 'America/Chicago';
  }

  if (c === 'united states' || c === 'usa' || c === 'us') {
    if (US_STATE_TZ[r]) return US_STATE_TZ[r];
    const abbr = US_ABBR[r.toUpperCase()];
    if (abbr && US_STATE_TZ[abbr]) return US_STATE_TZ[abbr];
  }

  if (c === 'canada') {
    if (CA_PROV_TZ[r]) return CA_PROV_TZ[r];
  }

  // Generic fallback
  return resolveTimezone(region);
}

/** Pull best tz from a user profile record */
function getUserTzFromProfile(userProfile) {
  if (userProfile?.timezone) return userProfile.timezone;
  const country = userProfile?.business_country || userProfile?.country || '';
  const region  = userProfile?.business_province || userProfile?.province || '';
  return suggestTimezone(country, region) || 'UTC';
}

module.exports = {
  isValidIanaTz,
  resolveTimezone,
  suggestTimezone,
  getUserTzFromProfile,
  CITY_MAP,
  CA_PROV_TZ
};
