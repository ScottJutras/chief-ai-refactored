// tools/approve_job_picker_template.js
// Usage:
//   node tools/approve_job_picker_template.js HX... chiefos_active_job_picker_dynamic_v1 UTILITY
//
// Notes:
// - name MUST be lowercase alphanumeric + underscore only
// - category MUST be UTILITY | MARKETING | AUTHENTICATION

const https = require("https");

const contentSid = String(process.argv[2] || "").trim();
const name = String(process.argv[3] || "").trim();
const category = String(process.argv[4] || "").trim().toUpperCase();

if (!/^HX[0-9a-fA-F]{32}$/.test(contentSid)) {
  console.error("Invalid Content SID. Expected something like: HX<32 hex chars>");
  process.exit(1);
}

if (!/^[a-z0-9_]+$/.test(name)) {
  console.error('Invalid name. Must be lowercase alphanumeric + underscores only (e.g. "chiefos_active_job_picker_dynamic_v1").');
  process.exit(1);
}

if (!["UTILITY", "MARKETING", "AUTHENTICATION"].includes(category)) {
  console.error('Invalid category. Must be UTILITY | MARKETING | AUTHENTICATION');
  process.exit(1);
}

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in env.");
  process.exit(1);
}

const body = JSON.stringify({ name, category });

const opts = {
  method: "POST",
  hostname: "content.twilio.com",
  path: `/v1/Content/${contentSid}/ApprovalRequests/whatsapp`,
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
  },
};

const req = https.request(opts, (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    let json = null;
    try { json = JSON.parse(data); } catch {}
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log("Approval request submitted!");
      console.log(json || data);
      process.exit(0);
    } else {
      console.error("Approval submit failed:", {
        status: res.statusCode,
        body: json || data,
      });
      process.exit(1);
    }
  });
});

req.on("error", (e) => {
  console.error("Request failed:", e?.message || e);
  process.exit(1);
});

req.write(body);
req.end();
