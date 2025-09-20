// utils/validateLocation.js
const areaCodeMap = require('./areaCodes'); // expects { [areaCode]: { country: 'Canada'|'USA'|..., state?: string, province?: string } }
const { suggestTimezone } = require('./timezones');

/**
 * Build validation lists (still used by onboarding).
 */
function getValidationLists() {
  console.log('[DEBUG] getValidationLists called');
  try {
    const provinces = new Set();
    const countries = new Set();

    Object.values(areaCodeMap).forEach(entry => {
      if (entry.state) provinces.add(entry.state);
      if (entry.province) provinces.add(entry.province);
      if (entry.country) countries.add(entry.country === 'USA' ? 'United States' : entry.country);
    });

    const result = {
      knownProvinces: Array.from(provinces),
      knownCountries: Array.from(countries)
    };
    console.log('[DEBUG] getValidationLists result:', result);
    return result;
  } catch (error) {
    console.error('[ERROR] getValidationLists failed:', error.message);
    return { knownProvinces: [], knownCountries: [] };
  }
}

/**
 * Detect country/province/timezone from a phone number.
 * Accepts formats: "whatsapp:+12223334444", "+12223334444", "12223334444", "2223334444"
 * Defaults to Canada/Ontario/America/Toronto if unknown.
 */
function detectLocation(phoneNumber) {
  console.log('[DEBUG] detectLocation called:', { phoneNumber });
  try {
    const raw = String(phoneNumber || '');
    // Strip non-digits, keep only numbers
    const digits = raw.replace(/\D/g, '');

    // Try to read NANP (+1) numbers
    let country = 'Canada';
    let province = 'Ontario';
    let timezone = 'America/Toronto';
    let areaCode = null;

    if (digits.length >= 10) {
      // If it starts with country code 1, area code is next 3
      if (digits.length === 11 && digits.startsWith('1')) {
        areaCode = digits.slice(1, 4);
      } else if (digits.length === 10) {
        // Assume NANP without country code
        areaCode = digits.slice(0, 3);
      }
    }

    if (areaCode && areaCodeMap[areaCode]) {
      const rec = areaCodeMap[areaCode];
      country = rec.country === 'USA' ? 'United States' : (rec.country || 'Canada');
      province = rec.state || rec.province || province;
      timezone = suggestTimezone(country, province, areaCode) || timezone;
    }

    const result = { country, province, timezone, areaCode };
    console.log('[DEBUG] detectLocation result:', result);
    return result;
  } catch (error) {
    console.error('[ERROR] detectLocation failed:', error.message);
    return { country: 'Canada', province: 'Ontario', timezone: 'America/Toronto', areaCode: null };
  }
}

module.exports = { getValidationLists, detectLocation };
