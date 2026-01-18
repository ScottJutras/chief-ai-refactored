// src/cil/schema.smoke.test.js
const { validateCIL } = require('./schema');

test('valid expense CIL passes', () => {
  const obj = {
    cil_version: '1.0',
    type: 'expense',
    tenant_id: 't1',
    source: 'whatsapp',
    source_msg_id: 'SM123',
    actor: { actor_id: 'u1', role: 'owner', phone_e164: '+14165551234' },
    occurred_at: new Date().toISOString(),
    job: { job_name: 'Roof Repair' },
    needs_job_resolution: false,
    total_cents: 8412,
    currency: 'CAD',
    vendor: 'Home Depot'
  };

  expect(() => validateCIL(obj)).not.toThrow();
});

test('missing total_cents fails', () => {
  const obj = {
    cil_version: '1.0',
    type: 'expense',
    tenant_id: 't1',
    source: 'whatsapp',
    source_msg_id: 'SM123',
    actor: { actor_id: 'u1', role: 'owner' },
    occurred_at: new Date().toISOString(),
    job: null,
    needs_job_resolution: true,
    currency: 'CAD'
  };

  expect(() => validateCIL(obj)).toThrow();
});
