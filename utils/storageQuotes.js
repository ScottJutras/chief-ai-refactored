// utils/storageQuotes.js
const { createClient } = require('@supabase/supabase-js');

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY; // IMPORTANT: server-only
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Upload quote PDF buffer to Supabase Storage
 * Returns { bucket, path }
 */
async function uploadQuotePdfBuffer({ ownerId, quoteId, buffer, bucket = 'quotes' }) {
  const supabase = getSupabaseAdmin();

  const owner = String(ownerId || '').replace(/\D/g, '');
  const qid = String(quoteId || '').trim();
  if (!owner || !qid) throw new Error('uploadQuotePdfBuffer missing ownerId/quoteId');
  if (!Buffer.isBuffer(buffer)) throw new Error('uploadQuotePdfBuffer expects Buffer');

  const path = `quotes/${owner}/${qid}/quote_v1.pdf`;

  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, {
      contentType: 'application/pdf',
      upsert: false // immutable by default
    });

  if (error) throw new Error(error.message || 'Storage upload failed');

  return { bucket, path };
}

/**
 * Create a signed URL (private bucket)
 */
async function createQuoteSignedUrl({ bucket = 'quotes', path, expiresInSec = 60 * 60 * 24 * 7 }) {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSec);

  if (error) throw new Error(error.message || 'Signed URL failed');

  return data?.signedUrl;
}

module.exports = { uploadQuotePdfBuffer, createQuoteSignedUrl };
