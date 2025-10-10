// services/geocode.js
const { query } = require('./postgres');

let fetchFn = global.fetch;
if (!fetchFn) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  fetchFn = require('node-fetch');
}

const ROUND = 5; // ~1.1m at equator
const keyFor = (lat, lng) => `${(+lat).toFixed(ROUND)},${(+lng).toFixed(ROUND)}`;

async function getCachedAddress(lat, lng) {
  const key = keyFor(lat, lng);
  const { rows } = await query(`SELECT address FROM geocode_cache WHERE key=$1`, [key]);
  return rows[0]?.address || null;
}

async function putCachedAddress(lat, lng, address) {
  const key = keyFor(lat, lng);
  await query(
    `INSERT INTO geocode_cache (key, address) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET address=EXCLUDED.address, created_at=now()`,
    [key, address]
  );
}

async function reverseGeocode(lat, lng) {
  if (lat == null || lng == null) return null;

  const cached = await getCachedAddress(lat, lng);
  if (cached) return cached;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null; // don’t hard-fail if key missing in dev

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
  const res = await fetchFn(url);
  if (!res.ok) return null;

  const data = await res.json();
  const addr = data?.results?.[0]?.formatted_address || null;
  if (addr) await putCachedAddress(lat, lng, addr);
  return addr;
}

module.exports = { reverseGeocode, getCachedAddress, putCachedAddress };
