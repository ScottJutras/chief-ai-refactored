// utils/validateLocation.js
const areaCodeMap = require('./areaCodes');
const { suggestTimezone } = require('./timezones');

function getValidationLists() {
  try {
    const provinces = new Set();
    const countries = new Set();

    Object.values(areaCodeMap).forEach(entry => {
      if (entry?.state) provinces.add(entry.state);
      if (entry?.province) provinces.add(entry.province);
      if (Array.isArray(entry?.provinces)) entry.provinces.forEach(p => provinces.add(p));
      if (entry?.country) countries.add(entry.country === 'USA' ? 'United States' : entry.country);
    });

    return {
      knownProvinces: Array.from(provinces),
      knownCountries: Array.from(countries),
    };
  } catch (e) {
    console.error('[ERROR] getValidationLists failed:', e.message);
    return { knownProvinces: [], knownCountries: [] };
  }
}

/**
 * PHONE-ONLY inference. If we’re not sure, return nulls (never a real default).
 */
function detectLocation(phoneNumber) {
  try {
    const digits = String(phoneNumber || '').replace(/\D/g, '');
    if (!digits) return { country: null, province: null, timezone: null, areaCode: null };

    let areaCode = null;
    if (digits.length === 11 && digits.startsWith('1')) areaCode = digits.slice(1, 4);
    else if (digits.length === 10) areaCode = digits.slice(0, 3);
    if (!areaCode) return { country: null, province: null, timezone: null, areaCode: null };

    const rec = areaCodeMap[areaCode];
    if (!rec) return { country: null, province: null, timezone: null, areaCode };

    const country = rec.country === 'USA' ? 'United States' : rec.country || null;

    // If NPA spans multiple provinces/states, don’t guess → province=null to force manual confirm.
    const province = Array.isArray(rec.provinces) ? null : (rec.state || rec.province || null);

    // Only suggest timezone when province is unambiguous
    const timezone = (country && province && suggestTimezone(country, province, areaCode)) || null;

    return { country, province, timezone, areaCode };
  } catch (e) {
    console.error('[ERROR] detectLocation failed:', e.message);
    return { country: null, province: null, timezone: null, areaCode: null };
  }
}

function isValidProvince(p) {
  if (!p) return false;
  const { knownProvinces } = getValidationLists();
  return knownProvinces.some(x => x.toLowerCase() === String(p).toLowerCase());
}
function isValidCountry(c) {
  if (!c) return false;
  const { knownCountries } = getValidationLists();
  return knownCountries.some(x => x.toLowerCase() === String(c).toLowerCase());
}

module.exports = { getValidationLists, detectLocation, isValidProvince, isValidCountry };
