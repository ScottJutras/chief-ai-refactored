// services/geocode.js
const pg = require('./postgres');

const query = pg.query || pg.pool?.query || pg.db?.query;
if (typeof query !== 'function') throw new Error('[geocode] postgres.query not available');

const fetchFn = global.fetch ? global.fetch.bind(global) : require('node-fetch');

const ROUND = 5;
const keyFor = (lat, lng) => `${(+lat).toFixed(ROUND)},${(+lng).toFixed(ROUND)}`;

async function getCachedAddress(lat, lng) {
  const key = keyFor(lat, lng);
  const { rows } = await query(`SELECT address FROM public.geocode_cache WHERE key=$1`, [key]);
  return rows?.[0]?.address || null;
}

async function putCachedAddress(lat, lng, address) {
  const key = keyFor(lat, lng);
  await query(
    `INSERT INTO public.geocode_cache (key, address)
     VALUES ($1,$2)
     ON CONFLICT (key)
     DO UPDATE SET address=EXCLUDED.address, created_at=NOW()`,
    [key, address]
  );
}

async function reverseGeocode(lat, lng) {
  if (lat == null || lng == null) return null;

  const cached = await getCachedAddress(lat, lng);
  if (cached) return cached;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(
    lat
  )},${encodeURIComponent(lng)}&key=${encodeURIComponent(apiKey)}`;

  const res = await fetchFn(url);
  if (!res.ok) return null;

  const data = await res.json();
  const addr = data?.results?.[0]?.formatted_address || null;
  if (addr) await putCachedAddress(lat, lng, addr);
  return addr;
}

module.exports = { reverseGeocode, getCachedAddress, putCachedAddress };
