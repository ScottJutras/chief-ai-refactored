// utils/taxRate.js

/**
 * Returns the tax rate for a given country and province/state.
 * @param {string} country - The user's country (e.g., "Canada", "United States").
 * @param {string} province - The user's province or state (e.g., "Ontario", "California").
 * @returns {number} The tax rate as a decimal (e.g., 0.13 for 13%).
 */
function getTaxRate(country, province) {
    const taxRates = {
        'Canada': {
            'Ontario': 0.13,         // 13% HST
            'British Columbia': 0.12, // 5% GST + 7% PST
            'Alberta': 0.05,         // 5% GST
            'Quebec': 0.14975,       // 5% GST + 9.975% QST
            'Nova Scotia': 0.15,     // 15% HST
            'Manitoba': 0.12,        // 5% GST + 7% PST
            'Saskatchewan': 0.11,    // 5% GST + 6% PST
            'New Brunswick': 0.15,   // 15% HST
            'Newfoundland and Labrador': 0.15, // 15% HST
            'Prince Edward Island': 0.15, // 15% HST
            'default': 0.05          // GST only for unlisted provinces
        },
        'United States': {
            'Alabama': 0.04,         // 4.00%
            'Alaska': 0.00,          // 0.00%
            'Arizona': 0.056,        // 5.60%
            'Arkansas': 0.065,       // 6.50%
            'California': 0.0725,    // 7.25%
            'Colorado': 0.029,       // 2.90%
            'Connecticut': 0.0635,   // 6.35%
            'Delaware': 0.00,        // 0.00%
            'Florida': 0.06,         // 6.00%
            'Georgia': 0.04,         // 4.00%
            'Hawaii': 0.04,          // 4.00%
            'Idaho': 0.06,           // 6.00%
            'Illinois': 0.0625,      // 6.25%
            'Indiana': 0.07,         // 7.00%
            'Iowa': 0.06,            // 6.00%
            'Kansas': 0.065,         // 6.50%
            'Kentucky': 0.06,        // 6.00%
            'Louisiana': 0.0445,     // 4.45%
            'Maine': 0.055,          // 5.50%
            'Maryland': 0.06,        // 6.00%
            'Massachusetts': 0.0625, // 6.25%
            'Michigan': 0.06,        // 6.00%
            'Minnesota': 0.0688,     // 6.88%
            'Mississippi': 0.07,     // 7.00%
            'Missouri': 0.0423,      // 4.23%
            'Montana': 0.00,         // 0.00%
            'Nebraska': 0.055,       // 5.50%
            'Nevada': 0.0685,        // 6.85%
            'New Hampshire': 0.00,   // 0.00%
            'New Jersey': 0.0663,    // 6.63%
            'New Mexico': 0.0488,    // 4.88%
            'New York': 0.04,        // 4.00%
            'North Carolina': 0.0475,// 4.75%
            'North Dakota': 0.05,    // 5.00%
            'Ohio': 0.0575,          // 5.75%
            'Oklahoma': 0.045,       // 4.50%
            'Oregon': 0.00,          // 0.00%
            'Pennsylvania': 0.06,    // 6.00%
            'Rhode Island': 0.07,    // 7.00%
            'South Carolina': 0.06,  // 6.00%
            'South Dakota': 0.042,   // 4.20%
            'Tennessee': 0.07,       // 7.00%
            'Texas': 0.0625,         // 6.25%
            'Utah': 0.061,           // 6.10%
            'Vermont': 0.06,         // 6.00%
            'Virginia': 0.053,       // 5.30%
            'Washington': 0.065,     // 6.50%
            'West Virginia': 0.06,   // 6.00%
            'Wisconsin': 0.05,       // 5.00%
            'Wyoming': 0.04,         // 4.00%
            'District of Columbia': 0.06, // 6.00%
            'default': 0.0           // No federal sales tax, default for unlisted states
        }
        // Add other countries as needed, e.g., 'Australia', 'United Kingdom'
    };

    const countryRates = taxRates[country] || {};
    const rate = countryRates[province] || countryRates['default'] || 0.0;
    console.log(`[DEBUG] Tax rate for ${country}, ${province}: ${rate * 100}%`);
    return rate;
}

module.exports = { getTaxRate };