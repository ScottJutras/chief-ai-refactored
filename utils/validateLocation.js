const areaCodeMap = require('./areaCodes.js');

function getValidationLists() {
    const provinces = new Set();
    const countries = new Set();

    Object.values(areaCodeMap).forEach(entry => {
        if (entry.state) {
            provinces.add(entry.state);
        } else if (entry.province) {
            provinces.add(entry.province);
        }
        countries.add(entry.country);
    });

    return {
        knownProvinces: Array.from(provinces),
        knownCountries: Array.from(countries)
    };
}

module.exports = { getValidationLists };