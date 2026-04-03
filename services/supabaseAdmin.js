// services/supabaseAdmin.js
// Supabase admin client for backend storage uploads (service role bypasses RLS)

let _client = null;

function getAdminClient() {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    || process.env.SUPABASE_URL
    || process.env.VITE_SUPABASE_URL
    || null;

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_SERVICE_KEY
    || null;

  if (!url || !key) {
    console.warn('[supabaseAdmin] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — storage uploads disabled');
    return null;
  }

  try {
    const { createClient } = require('@supabase/supabase-js');
    _client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    return _client;
  } catch (e) {
    console.warn('[supabaseAdmin] createClient failed:', e?.message);
    return null;
  }
}

/**
 * Upload a buffer to Supabase Storage.
 * Returns the public URL on success, null on failure.
 */
async function uploadToStorage({ bucket, path, buffer, contentType }) {
  const client = getAdminClient();
  if (!client) return null;

  try {
    const { error } = await client.storage
      .from(bucket)
      .upload(path, buffer, {
        contentType: contentType || 'image/jpeg',
        upsert: true,
      });

    if (error) {
      console.error('[supabaseAdmin] upload error:', error.message);
      return null;
    }

    const { data } = client.storage.from(bucket).getPublicUrl(path);
    return data?.publicUrl || null;
  } catch (e) {
    console.error('[supabaseAdmin] uploadToStorage failed:', e?.message);
    return null;
  }
}

/**
 * Get signed URL for private buckets, or public URL for public buckets.
 */
async function getPublicUrl(bucket, path) {
  const client = getAdminClient();
  if (!client) return null;
  try {
    const { data } = client.storage.from(bucket).getPublicUrl(path);
    return data?.publicUrl || null;
  } catch {
    return null;
  }
}

module.exports = { getAdminClient, uploadToStorage, getPublicUrl };
