/**
 * tools/create_job_picker_template.js
 *
 * Creates a WhatsApp List Picker Content template via Twilio Content API.
 *
 * IMPORTANT:
 * - Uses the correct schema: types["twilio/list-picker"]
 * - Each item MUST have non-null: item, id (description can be static)
 * - Keeps variable count lower to avoid WhatsApp rejection.
 *
 * Run:
 *   node tools/create_job_picker_template.js
 */

const https = require("https");

function mustEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function b64(s) {
  return Buffer.from(String(s || ""), "utf8").toString("base64");
}

function postJson(url, authUser, authPass, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(data);

    const req = https.request(
      {
        method: "POST",
        hostname: u.hostname,
        path: u.pathname + (u.search || ""),
        headers: {
          Authorization: `Basic ${b64(`${authUser}:${authPass}`)}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve({ status: res.statusCode, body: parsed });
          }

          return reject({ status: res.statusCode, body: parsed });
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function buildTemplate() {
  // 8 rows, 2 vars each (item + id) = 16 vars
  // plus body + button = 2 vars
  // total vars = 18
  //
  // Variables:
  // 1: dynamic body text (you send this at runtime)
  // 2: dynamic button text (you send this at runtime)
  // 3: row1 item, 4: row1 id
  // 5: row2 item, 6: row2 id
  // ...
  // 17: row8 item, 18: row8 id

  const items = [];
  let v = 3;
  for (let i = 0; i < 8; i++) {
    items.push({
      item: `{{${v}}}`,
      id: `{{${v + 1}}}`,
      // keep description STATIC to reduce variables
      description: "Tap to select this job",
    });
    v += 2;
  }

  // Add enough static words around {{1}} to satisfy WhatsApp variable/length rules.
  // (This body is intentionally “wordy” to pass approval.)
  const body =
    "ChiefOS job picker — {{1}} " +
    "Tap a job below to attach this entry. " +
    "If you do not see the right job, reply MORE for the next page. " +
    "For non job costs, reply OVERHEAD. " +
    "You can also reply with a job number or type part of the job name. " +
    "If this list expires or fails, reply CHANGE JOB to open it again.";

  const payload = {
    friendly_name: "chiefos_active_job_picker_dynamic_v2",
    language: "en",
    variables: {
      // These are SAMPLE / DEFAULTS required for creation + approval.
      // They are NOT what gets sent in production (you override via contentVariables).
      "1": "Pick the job for this entry.",
      "2": "Pick job",

      "3": "Job #1556 — Medway Park Dr",
      "4": "jp:sample:row1",
      "5": "Job #1559 — Medway Park Dr",
      "6": "jp:sample:row2",
      "7": "Oak Street Re-roof",
      "8": "jp:sample:row3",
      "9": "Test Job A",
      "10": "jp:sample:row4",
      "11": "Test Job B",
      "12": "jp:sample:row5",
      "13": "Happy Road",
      "14": "jp:sample:row6",
      "15": "Happy Street",
      "16": "jp:sample:row7",
      "17": "Overhead / Shop",
      "18": "jp:sample:row8",
    },
    types: {
      "twilio/list-picker": {
        body,
        button: "{{2}}",
        items,
      },
      // Optional: include a text fallback type (harmless, can help some channels)
      "twilio/text": {
        body:
          "ChiefOS job picker: {{1}} Reply with a number or type the job name. " +
          "If you do not see it, reply MORE. For non job costs, reply OVERHEAD.",
      },
    },
  };

  return payload;
}

async function main() {
  const accountSid = mustEnv("TWILIO_ACCOUNT_SID");
  const authToken = mustEnv("TWILIO_AUTH_TOKEN");

  const payload = buildTemplate();

  try {
    const resp = await postJson("https://content.twilio.com/v1/Content", accountSid, authToken, payload);
    console.log("Created Content Template!");
    console.log("Content SID:", resp?.body?.sid);
    console.log("Friendly name:", resp?.body?.friendly_name);
  } catch (e) {
    console.error("Create failed:", e);
    process.exit(1);
  }
}

main();
