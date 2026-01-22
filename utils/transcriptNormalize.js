// utils/transcriptNormalize.js

function normalizeTranscriptMoney(text) {
  let s = String(text || '');

  // Minimal high-signal replacements (expand later):
  const wordToNum = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
  };

  const normWord = (w) => String(w || '').toLowerCase();

  // "ten dollars" -> "$10"
  s = s.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+dollars?\b/gi,
    (m, w) => `$${wordToNum[normWord(w)]}`
  );

  // "eighteen hundred dollars" -> "$1800"
  s = s.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+hundred\s+dollars?\b/gi,
    (m, w) => `$${wordToNum[normWord(w)] * 100}`
  );

  // "eighteen hundred and fifty dollars" -> "$1850"
  // also matches: "eighteen hundred fifty dollars"
  s = s.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+hundred(?:\s+and)?\s+(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+dollars?\b/gi,
    (m, hundredsWord, tensWord) => {
      const h = wordToNum[normWord(hundredsWord)] * 100;
      const t = wordToNum[normWord(tensWord)] || 0;
      return `$${h + t}`;
    }
  );

  // "one thousand eight hundred dollars" -> "$1800"
  // supports: "<1-20> thousand <1-20> hundred dollars"
  s = s.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+thousand\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+hundred\s+dollars?\b/gi,
    (m, thousandWord, hundredWord) => {
      const th = wordToNum[normWord(thousandWord)] * 1000;
      const h = wordToNum[normWord(hundredWord)] * 100;
      return `$${th + h}`;
    }
  );

  return s;
}

function stripLeadingFiller(text) {
  let s = String(text || '').trim();

  // Remove common fillers at start (can repeat)
  s = s.replace(/^(?:uh+|um+|erm+|ah+|like|okay|ok|so|well)[,\s]+/i, '');
  s = s.replace(/^(?:uh+|um+|erm+|ah+|like|okay|ok|so|well)[,\s]+/i, '');

  return s.trim();
}


module.exports = {
  normalizeTranscriptMoney,
  stripLeadingFiller
};

