const { validateCIL } = require("../src/cil/schema");

try {
  const ok = validateCIL({
    cil_version: "1.0",
    type: "expense",
    tenant_id: "t1",
    source: "whatsapp",
    source_msg_id: "SM123",
    actor: { actor_id: "u1", role: "owner", phone_e164: "+14165551234" },
    occurred_at: new Date().toISOString(),
    job: { job_name: "Roof Repair" },
    needs_job_resolution: false,
    total_cents: 8412,
    currency: "CAD",
    vendor: "Home Depot",
  });

  console.log("✅ CIL valid:", ok.type);
} catch (e) {
  console.error("❌ CIL invalid:", e.errors ?? e);
  process.exit(1);
}
