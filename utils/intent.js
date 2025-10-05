function inferIntentFromText(s = '') {
  const lc = String(s).toLowerCase();
  if (/\b(clock|punch)\s+in\b/.test(lc) || /\bstart\s+(work|shift)\b/.test(lc)) return 'punch_in';
  if (/\b(clock|punch)\s+out\b/.test(lc) || /\b(end|finish|stop)\s+(work|shift)\b/.test(lc)) return 'punch_out';
  if (/\b(start|begin)\s+(break|lunch)\b/.test(lc) || /\bon\s+break\b/.test(lc)) return 'break_start';
  if (/\b(end|finish)\s+(break|lunch)\b/.test(lc) || /\boff\s+break\b/.test(lc)) return 'break_end';
  return null;
}

module.exports = { inferIntentFromText };