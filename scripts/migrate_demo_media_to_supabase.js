/* eslint-disable no-console */
const pg = require("pg");
const { createClient } = require("@supabase/supabase-js");

const DEMO_TENANT_ID = "8ae033e0-3106-4c97-a166-b794a112a5ec";
const OWNER_ID = "19053279955";
const BUCKET = "chiefos-media";
const CONCURRENCY = 3;

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function extFromContentType(ct) {
  const x = String(ct || "").toLowerCase();
  if (x.includes("pdf")) return "pdf";
  if (x.includes("png")) return "png";
  if (x.includes("jpeg") || x.includes("jpg")) return "jpg";
  if (x.includes("webp")) return "webp";
  if (x.includes("audio/ogg")) return "ogg";
  if (x.includes("audio/mpeg")) return "mp3";
  if (x.includes("audio/mp4")) return "m4a";
  return "bin";
}

async function fetchTwilioBytes(url) {
  const sid = mustEnv("TWILIO_ACCOUNT_SID");
  const token = mustEnv("TWILIO_AUTH_TOKEN");

  const r = await fetch(url, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
    },
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Twilio fetch failed ${r.status}: ${t.slice(0, 200)}`);
  }

  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

function makeSupabaseAdmin() {
  const raw =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "";

  if (!raw) {
    throw new Error("Missing env var: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)");
  }

  const url = raw.replace(/\/$/, "");
  const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
}

async function main() {
  const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.SUPABASE_DATABASE_URL || // optional alias if you ever use it
  "";

if (!DATABASE_URL) throw new Error("Missing env var: DATABASE_URL");
  const dryRun = process.argv.includes("--dry-run");

  const db = new pg.Pool({ connectionString: DATABASE_URL });
  const supa = makeSupabaseAdmin();

  console.log(`Starting migration (dryRun=${dryRun})`);
  console.log(`Tenant: ${DEMO_TENANT_ID}`);
  console.log(`Owner:  ${OWNER_ID}`);
  console.log(`Bucket: ${BUCKET}`);

  // 1) Pull demo media assets that still point to twilio_temp
  const { rows } = await db.query(
    `
    select id, tenant_id, owner_id, storage_provider, storage_path, content_type, created_at
    from public.media_assets
    where tenant_id = $1::uuid
      and storage_provider = 'twilio_temp'
      and storage_path like 'http%'
    order by created_at asc
    `,
    [DEMO_TENANT_ID]
  );

  console.log(`Found ${rows.length} demo media rows to migrate.`);

  let ok = 0;
  let fail = 0;

  // Simple worker pool
  const queue = rows.slice();
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const row = queue.shift();
      if (!row) break;

      const id = row.id;
      const ct = row.content_type || "application/octet-stream";
      const ext = extFromContentType(ct);

      // store inside tenant folder so it’s clean + deterministic
      const objectPath = `receipts/${DEMO_TENANT_ID}/${id}.${ext}`;
      const newStoragePath = `${BUCKET}/${objectPath}`;

      try {
        console.log(`→ ${id}  (${ct})`);

        if (!dryRun) {
          const bytes = await fetchTwilioBytes(row.storage_path);

          const up = await supa.storage.from(BUCKET).upload(objectPath, bytes, {
            contentType: ct,
            upsert: true, // safe to retry
          });

          if (up.error) throw new Error(`Supabase upload error: ${up.error.message}`);

          // Update DB row
          await db.query(
            `
            update public.media_assets
            set storage_provider = 'supabase',
                storage_path = $2,
                updated_at = now()
            where id = $1::uuid
              and tenant_id = $3::uuid
            `,
            [id, newStoragePath, DEMO_TENANT_ID]
          );
        }

        ok++;
      } catch (e) {
        fail++;
        console.warn(`✗ ${id} failed: ${e.message}`);
      }
    }
  });

  await Promise.all(workers);

  console.log(`Done. ok=${ok} fail=${fail}`);

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});