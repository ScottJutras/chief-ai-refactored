const { parsePhoneNumberFromString } = require('libphonenumber-js');
const areaCodeMap = require('./areaCodes'); // Import areaCodeMap

function detectCountryAndRegion(phoneNumber) {
  if (!phoneNumber.startsWith("+")) {
    phoneNumber = `+${phoneNumber}`;
  }
  const phoneInfo = parsePhoneNumberFromString(phoneNumber);
  if (!phoneInfo || !phoneInfo.isValid()) {
    return { country: "Unknown", region: "Unknown" };
  }
  const nationalNumber = phoneInfo.nationalNumber;
  const areaCode = nationalNumber.substring(0, 3);
  const location = areaCodeMap[areaCode];
  if (location) {
    return { country: location.country, region: location.province || location.state || "Unknown" };
  }
  return { country: phoneInfo.country || "Unknown", region: "Unknown" };
}

module.exports = { detectCountryAndRegion };