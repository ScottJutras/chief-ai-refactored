const areaCodeMap = require('./areaCodes');

function getValidationLists() {
  const provinces = new Set();
  const countries = new Set();
  Object.values(areaCodeMap).forEach(entry => {
    if (entry.state) provinces.add(entry.state);
    else if (entry.province) provinces.add(entry.province);
    countries.add(entry.country);
  });
  return {
    knownProvinces: Array.from(provinces),
    knownCountries: Array.from(countries)
  };
}

function detectLocation(phoneNumber) {
  console.log('[DEBUG] detectLocation called:', { phoneNumber });
  try {
    const countryCode = phoneNumber.match(/^\+(\d{1,3})/)?.[1];
    let country = 'Canada'; // Default
    let province = 'Ontario'; // Default
    if (countryCode === '1') {
      const areaCode = phoneNumber.match(/^\+1(\d{3})/)?.[1];
      if (areaCode && areaCodeMap[areaCode]) {
        country = areaCodeMap[areaCode].country === 'USA' ? 'United States' : areaCodeMap[areaCode].country;
        province = areaCodeMap[areaCode].state || areaCodeMap[areaCode].province || 'Ontario';
      }
    }
    console.log('[DEBUG] detectLocation result:', { country, province });
    return { country, province };
  } catch (error) {
    console.error('[ERROR] detectLocation failed:', error.message);
    return { country: 'Canada', province: 'Ontario' };
  }
}

module.exports = { getValidationLists, detectLocation };