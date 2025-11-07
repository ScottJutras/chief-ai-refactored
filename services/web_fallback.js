// services/web_fallback.js
// Web search fallback with citations. Replace stub with Tavily/SerpAPI.
const fetch = require('node-fetch');

const TAVILY_API_KEY = process.env.TAVILY_API_KEY; // or your provider key

async function searchWeb(q) {
  if (!TAVILY_API_KEY) return { answer: 'Web search unavailable.', results: [] };
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: TAVILY_API_KEY, query: q, include_answer: true, max_results: 5 })
  });
  if (!r.ok) throw new Error('web search failed');
  return await r.json();
}

function cite(answer) {
  if (!answer?.results?.length) return '';
  const top = answer.results.slice(0,3).map(r => `• ${r.title} — ${r.url}`).join('\n');
  return `\n\nSources:\n${top}`;
}

async function webAnswer({ text }) {
  try {
    const out = await searchWeb(text);
    const a = out?.answer || `Here’s what I found.`;
    return { text: `${a}${cite(out)}` };
  } catch {
    return { text: `I couldn’t find a definitive source. Try rephrasing or narrowing the topic.` };
  }
}

module.exports = { webAnswer };