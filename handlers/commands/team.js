// handlers/commands/team.js
// Owner-mediated employee records (Free/Starter/Pro), with plan gate on max_employee_records.
//
// Commands:
// - "team" / "employees" / "crew"         -> list
// - "add employee John"                   -> add (name only)
// - "add employee John +15195551234"      -> add (name + phone, optional)
// - "remove employee John"                -> remove by name
// - "remove employee +1519..."            -> remove by phone
//
// NOTE: This file is for *records* only.
// Self-logging from employee phones is gated elsewhere (Gate #1, Pro only).

const pg = require('../../services/postgres');

function RESP(t) {
  const s = String(t || '').trim();
  return `<Response><Message>${s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')}</Message></Response>`;
}

function DIGITS(x) {
  return String(x ?? '').replace(/^whatsapp:/i, '').replace(/^\+/, '').replace(/\D/g, '');
}

function parseAdd(line) {
  // add employee <name> [phone]
  const m = String(line || '').match(/^(?:add\s+(?:employee|emp|crew))\s+(.+?)\s*(\+?[\d\-\(\)\s\.]{7,})?$/i);
  if (!m) return null;
  const name = String(m[1] || '').trim();
  const rawPhone = String(m[2] || '').trim();
  const phone = rawPhone ? DIGITS(rawPhone) : '';
  return { name, phone: phone || null };
}

function parseRemove(line) {
  const s = String(line || '').trim();
  const m1 = s.match(/^(?:remove\s+(?:employee|emp|crew))\s+(\+?[\d\-\(\)\s\.]{7,})$/i);
  if (m1) return { phone: DIGITS(m1[1]) || null, name: null };

  const m2 = s.match(/^(?:remove\s+(?:employee|emp|crew))\s+(.+)$/i);
  if (m2) return { name: String(m2[1] || '').trim(), phone: null };

  return null;
}

async function resolveCaps(planKey) {
  const plan = String(planKey || 'free').toLowerCase().trim() || 'free';

  try {
    const capMod = require('../../src/config/capabilities');
    const fn =
      capMod?.getCapabilitiesForPlan ||
      capMod?.resolveCapabilities ||
      capMod?.getPlanCapabilities ||
      null;

    if (typeof fn === 'function') return fn(plan);
  } catch {}

  try {
    const { plan_capabilities } = require('../../src/config/planCapabilities');
    return plan_capabilities?.[plan] || plan_capabilities?.free || null;
  } catch {}

  return null;
}

async function employeesTableHasColumn(col) {
  try {
    const { rows } = await pg.query(
      `
      select 1
        from information_schema.columns
       where table_schema='public'
         and table_name='employees'
         and column_name=$1
       limit 1
      `,
      [String(col)]
    );
    return (rows?.length || 0) > 0;
  } catch {
    return false;
  }
}

async function handleTeam(from, input, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId = null) {
  try {
    if (!isOwner) return res.send(RESP(`Only the Owner can manage employees.`));

    const owner = String(ownerId || '').trim();
    if (!owner) return res.send(RESP(`Missing owner context.`));

    const msg = String(input || '').trim();
    const lc = msg.toLowerCase();

    // Plan + caps
    const rawPlan = String(ownerProfile?.plan_key || ownerProfile?.paid_tier || ownerProfile?.subscription_tier || 'free');
    const caps = await resolveCaps(rawPlan);
    const maxEmployees = caps?.people?.max_employee_records;

if (maxEmployees != null && Number.isFinite(Number(maxEmployees))) {
  const { rows } = await pg.query(
    `select count(*)::int as c from public.employees where owner_id=$1`,
    [owner]
  );
  const c = Number(rows?.[0]?.c || 0);

  if (c >= Number(maxEmployees)) {
    // block + upsell copy...
  }
}


    // LIST
    if (/^(team|employees|crew)\b/i.test(msg)) {
      const { rows } = await pg.query(
        `select id, name, phone
           from public.employees
          where owner_id=$1
          order by created_at asc
          limit 200`,
        [owner]
      );

      if (!rows?.length) {
        return res.send(RESP(`No employees yet.\n\nAdd one:\nadd employee John\nadd employee John +15195551234`));
      }

      const lines = rows.slice(0, 50).map((r, i) => {
        const nm = String(r?.name || '').trim() || 'Unnamed';
        const ph = r?.phone ? ` (+${String(r.phone).replace(/\D/g, '')})` : '';
        return `${i + 1}. ${nm}${ph}`;
      });

      const capLine = Number.isFinite(Number(maxEmployees))
        ? `\n\nPlan limit: ${rows.length}/${maxEmployees} employee records.`
        : '';

      return res.send(RESP(`Employees:\n${lines.join('\n')}${capLine}`));
    }

    // ADD
if (/^add\s+(employee|emp|crew)\b/i.test(msg)) {
  const parsed = parseAdd(msg);
  if (!parsed?.name) {
    return res.send(RESP(`Try:\nadd employee John\nadd employee John +15195551234`));
  }

  // Gate #3 — max_employee_records (only if it's a real number)
  if (maxEmployees != null && Number.isFinite(Number(maxEmployees))) {
    const { rows } = await pg.query(
      `select count(*)::int as c from public.employees where owner_id=$1`,
      [owner]
    );
    const c = Number(rows?.[0]?.c || 0);

    if (c >= Number(maxEmployees)) {
      const planLc = String(rawPlan || 'free').toLowerCase();
      const tierLine =
        planLc.includes('free')
          ? `Free supports up to ${maxEmployees} employee records. Upgrade to Starter (10) or Pro (25).`
          : `Your plan supports up to ${maxEmployees} employee records. Upgrade to Pro for more.`;

      return res.send(RESP(`⚠️ Employee limit reached (${c}/${maxEmployees}).\n\n${tierLine}`));
    }
  }

  // Insert (schema-tolerant: phone/source_msg_id exist; role/active may be required)
  const hasPhone = await employeesTableHasColumn('phone');
  const hasSource = await employeesTableHasColumn('source_msg_id'); // will be false until you add column
  const hasRole = await employeesTableHasColumn('role');
  const hasActive = await employeesTableHasColumn('active');

  const cols = ['owner_id', 'name', 'created_at'];
  const vals = ['$1', '$2', 'now()'];
  const params = [owner, parsed.name];

  // ✅ role is NOT NULL in your schema — set it when column exists
  if (hasRole) {
    cols.push('role');
    vals.push(`$${params.length + 1}`);
    params.push('employee'); // canonical default
  }

  // optional active flag (your table has it)
  if (hasActive) {
    cols.push('active');
    vals.push(`$${params.length + 1}`);
    params.push(true);
  }

  if (hasPhone) {
    cols.push('phone');
    vals.push(`$${params.length + 1}`);
    params.push(parsed.phone);
  }

  // Only add source_msg_id if col exists AND we have a non-empty value
  const sourceVal = String(sourceMsgId || '').trim() || null;
  const willWriteSource = !!(hasSource && sourceVal);
  if (willWriteSource) {
    cols.push('source_msg_id');
    vals.push(`$${params.length + 1}`);
    params.push(sourceVal);
  }

  const sql = `
    insert into public.employees (${cols.join(', ')})
    values (${vals.join(', ')})
    returning id, name
  `;

  let r;
  try {
    r = await pg.query(sql, params);
  } catch (e) {
    // ✅ If DB trigger blocks (Gate #3), return friendly upsell instead of “Team error”
    if (String(e?.code) === 'P0001' && /employee_limit_reached/i.test(String(e?.message || ''))) {
      const planLc = String(rawPlan || 'free').toLowerCase();
      const tierLine =
        planLc.includes('free')
          ? `Free supports up to ${maxEmployees ?? 3} employee records. Upgrade to Starter (10) or Pro (25).`
          : `Your plan supports up to ${maxEmployees ?? 10} employee records. Upgrade to Pro for more.`;

      return res.send(RESP(`⚠️ Employee limit reached.\n\n${tierLine}`));
    }

    // ✅ Twilio retry idempotency (only if we actually wrote source_msg_id)
    if (String(e?.code) === '23505' && willWriteSource) {
      return res.send(RESP(`✅ Added employee: ${parsed.name}`));
    }

    throw e;
  }

  const nm = String(r?.rows?.[0]?.name || parsed.name).trim();
  return res.send(RESP(`✅ Added employee: ${nm}`));
}

    // REMOVE
    if (/^remove\s+(employee|emp|crew)\b/i.test(msg)) {
      const parsed = parseRemove(msg);
      if (!parsed) return res.send(RESP(`Try:\nremove employee John\nremove employee +15195551234`));

      // Prefer phone if present + column exists
      const hasPhone = await employeesTableHasColumn('phone');

      let out;
      if (parsed.phone && hasPhone) {
        out = await pg.query(
          `delete from public.employees
            where owner_id=$1 and regexp_replace(coalesce(phone,''), '\\D', '', 'g')=$2`,
          [owner, String(parsed.phone)]
        );
      } else if (parsed.name) {
        out = await pg.query(
          `delete from public.employees
            where owner_id=$1 and lower(name)=lower($2)`,
          [owner, parsed.name]
        );
      } else {
        return res.send(RESP(`I couldn’t tell who to remove. Try "remove employee John".`));
      }

      if ((out?.rowCount || 0) > 0) return res.send(RESP(`✅ Removed.`));
      return res.send(RESP(`Not found.`));
    }

    // Help
    return res.send(
      RESP(
        `Employee commands:\n` +
        `- team\n` +
        `- add employee John\n` +
        `- add employee John +15195551234\n` +
        `- remove employee John`
      )
    );
  } catch (e) {
    console.error('[team] error:', e?.message);
    return res.send(RESP(`Team error. Try again.`));
  } finally {
    try {
      res?.req?.releaseLock?.();
    } catch {}
  }
}

module.exports = { handleTeam };
