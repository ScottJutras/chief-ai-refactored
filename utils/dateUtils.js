// utils/dateUtils.js

/**
 * Timezone-aware "today" (YYYY-MM-DD) using Intl.
 * If tz is invalid or Intl fails, fall back to server time.
 */
function todayInTimeZone(tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    // en-CA yields YYYY-MM-DD
    return dtf.format(new Date());
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

/**
 * Parse common natural date tokens into YYYY-MM-DD.
 * Supports: today/yesterday/tomorrow, ISO, and "Dec 12, 2025" formats.
 * tz is optional but recommended so "today" matches the user's locale.
 */
function parseNaturalDate(s, tz) {
  const t = String(s || '').trim().toLowerCase();

  const today = todayInTimeZone(tz || 'UTC');
  if (!t || t === 'today') return today;

  if (t === 'yesterday') {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  }

  if (t === 'tomorrow') {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
  }

  // strict ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  // “December 12, 2025”, “Dec 12 2025”, etc. — avoid Date.parse() timezone drift
  {
    const mm = String(s || '').trim().match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
    if (mm) {
      const monRaw = mm[1].toLowerCase();
      const day = Number(mm[2]);
      const year = Number(mm[3]);

      const months = {
        jan: 1, january: 1,
        feb: 2, february: 2,
        mar: 3, march: 3,
        apr: 4, april: 4,
        may: 5,
        jun: 6, june: 6,
        jul: 7, july: 7,
        aug: 8, august: 8,
        sep: 9, sept: 9, september: 9,
        oct: 10, october: 10,
        nov: 11, november: 11,
        dec: 12, december: 12
      };

      const month = months[monRaw];
      if (month && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
        const mm2 = String(month).padStart(2, '0');
        const dd2 = String(day).padStart(2, '0');
        return `${year}-${mm2}-${dd2}`;
      }
    }
  }

  return null;
}

/**
 * stripDateTail(raw, tz?)
 * Pull a trailing date-ish token off the end, if present.
 */
function stripDateTail(raw = '', tz) {
  const s = String(raw).trim();

  // ISO at end, optionally preceded by "on"
  const mIso = s.match(/\s+(?:on\s+)?(?<date>\d{4}-\d{2}-\d{2})\b[\s\.\!\?,]*$/i);
  if (mIso?.groups?.date) {
    return { rest: s.slice(0, mIso.index).trim(), date: mIso.groups.date };
  }

  // today/yesterday/tomorrow at end, optionally preceded by "on"
  const mWord = s.match(/\s+(?:on\s+)?(?<date>today|yesterday|tomorrow)\b[\s\.\!\?,]*$/i);
  if (mWord?.groups?.date) {
    return { rest: s.slice(0, mWord.index).trim(), date: parseNaturalDate(mWord.groups.date, tz) };
  }

  // Try natural language date at the end (best-effort)
  const mTail = s.match(/\s+(?:on\s+)?(?<date>[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b[\s\.\!\?,]*$/);
  if (mTail?.groups?.date) {
    const d = parseNaturalDate(mTail.groups.date, tz);
    if (d) return { rest: s.slice(0, mTail.index).trim(), date: d };
  }

  return { rest: s, date: null };
}

module.exports = {
  todayInTimeZone,
  parseNaturalDate,
  stripDateTail
};