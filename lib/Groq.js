'use strict';
// Shared helpers for the /api functions (CommonJS, Node runtime — works on Vercel
// with no package.json config or build step).
//
// WHY THIS FILE EXISTS
// Groq retires models every few weeks (see console.groq.com/docs/deprecations).
// Hard-coding a model name is what silently broke chat before. Instead, this
// asks Groq which models are live on YOUR key right now (GET /models), picks
// the best one from a preference list, and falls through to the next candidate
// if one fails. It should keep working through future model retirements.

const GROQ_BASE = 'https://api.groq.com/openai/v1';

// Best first. Verified against Groq's deprecation table on 2026-09-29:
//   text   -> openai/gpt-oss-120b (current), qwen/qwen3.8-27b, openai/gpt-oss-20b
//   vision -> qwen/qwen3.8-27b (multimodal; Llama 4 Scout was retired 07/17/26)
const TEXT_PREFERENCE = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];
const VISION_PREFERENCE = ['qwen/qwen3.8-27b'];

const NOT_CHAT = /whisper|orpheus|tts|guard|safeguard|compound|embed|moderation/i;
// Known retired IDs — never pick these even if some endpoint still lists them.
const RETIRED = new Set([
  'qwen/qwen3-32b', 'qwen/qwen3.6-27b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant',
  'meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct',
  'groq/compound', 'groq/compound-mini',
]);

function shorten(s, n) { s = String(s || ''); return s.length > (n || 220) ? s.slice(0, n || 220) + '…' : s; }

async function timedFetch(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 15000);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
  } catch (e) {
    if (e && e.name === 'AbortError') { const err = new Error('timeout after ' + (ms || 15000) + 'ms'); err.status = 0; throw err; }
    throw e;
  } finally { clearTimeout(t); }
}

// ---- live model discovery (cached 5 min per warm function instance) ----
let modelCache = { at: 0, key: '', ids: null };
async function listModels(key) {
  const now = Date.now();
  if (modelCache.ids && modelCache.key === key && now - modelCache.at < 5 * 60 * 1000) return modelCache.ids;
  try {
    const r = await timedFetch(GROQ_BASE + '/models', { headers: { Authorization: 'Bearer ' + key } }, 8000);
    if (!r.ok) return null;
    const j = await r.json();
    const ids = (j.data || []).filter(m => m && m.active !== false).map(m => m.id);
    modelCache = { at: now, key, ids };
    return ids;
  } catch (e) { return null; }
}

function candidates(ids, kind) {
  const pref = kind === 'vision' ? VISION_PREFERENCE : TEXT_PREFERENCE;
  if (!ids) return pref.slice();              // couldn't list models: try the preference list blindly
  const live = pref.filter(m => ids.includes(m));
  const extras = ids.filter(id => !pref.includes(id) && !RETIRED.has(id) && !NOT_CHAT.test(id));
  const extraOk = kind === 'vision' ? extras.filter(id => /vl|vision|qwen3\.\d|gemma-?3|pixtral|llava/i.test(id)) : extras;
  return live.concat(extraOk).slice(0, 4);
}

async function callOnce(key, model, messages, extra, timeoutMs) {
  const r = await timedFetch(GROQ_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(Object.assign({ model, messages, temperature: 0.3 }, extra)),
  }, timeoutMs);
  const raw = await r.text();
  if (!r.ok) { const e = new Error(r.status + ' ' + shorten(raw)); e.status = r.status; throw e; }
  let data;
  try { data = JSON.parse(raw); } catch (_) { const e = new Error('non-JSON response from Groq'); e.status = 502; throw e; }
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  let text = msg && typeof msg.content === 'string' ? msg.content : '';
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();   // reasoning models can leak this
  if (!text) { const e = new Error('empty reply (model may have used all tokens reasoning)'); e.status = 0; throw e; }
  return text;
}

// Chat via Groq with model discovery + per-model fallback.
async function groqChat(opts) {
  const key = opts.key, kind = opts.kind || 'text', maxTokens = opts.maxTokens || 3000;
  if (!key) { const e = new Error('no-key'); e.details = ['groq: no-key']; throw e; }
  const ids = await listModels(key);
  const cands = candidates(ids, kind);
  if (!cands.length) {
    const e = new Error(kind === 'vision' ? 'no vision-capable model available on this Groq key' : 'no chat model available on this Groq key');
    e.details = ['groq: ' + e.message + (ids ? ' (live models: ' + ids.join(', ') + ')' : '')];
    throw e;
  }
  const errors = [];
  for (const model of cands) {
    // Some models reject certain params; retry with progressively plainer ones.
    const variants = [
      { reasoning_effort: 'low', max_completion_tokens: maxTokens },
      { max_completion_tokens: maxTokens },
      { max_tokens: maxTokens },
    ];
    for (let v = 0; v < variants.length; v++) {
      try {
        const text = await callOnce(key, model, opts.messages, variants[v], opts.timeoutMs || 25000);
        return { text, model };
      } catch (e) {
        const msg = e.message || String(e);
        errors.push(model + ': ' + msg);
        if (e.status === 401 || e.status === 403) { const err = new Error('key rejected'); err.details = ['groq: ' + errors.join(' | ')]; throw err; }
        const paramProblem = e.status === 400 && /reasoning_effort|max_completion_tokens|max_tokens|unsupported parameter|additional propert|unknown/i.test(msg);
        if (paramProblem && v < variants.length - 1) continue;   // same model, plainer params
        break;                                                     // otherwise move to the next model
      }
    }
  }
  const err = new Error('all Groq models failed');
  err.details = ['groq: ' + errors.join(' | ')];
  throw err;
}

// Plain-English cause for the user, so nobody needs DevTools to know what's wrong.
function hintFromErrors(errors) {
  errors = errors || [];
  const groq = errors.find(e => e.indexOf('groq:') === 0) || '';
  const others = errors.filter(e => e.indexOf('groq:') !== 0 && !/no-key/.test(e));
  if (/no-key/.test(groq)) return others.length ? 'Groq key missing and backup providers failed — add GROQ_API_KEY in Vercel and redeploy once.'
    : "GROQ_API_KEY isn't set for this Vercel project. Vercel → Settings → Environment Variables → add it, then redeploy once.";
  if (/key rejected|\b401\b|invalid api key|invalid_api_key/i.test(groq)) return 'Groq rejected the API key. Create a fresh key at console.groq.com and update GROQ_API_KEY in Vercel, then redeploy once.';
  if (/\b429\b|rate.?limit/i.test(groq)) return 'Groq rate limit reached — wait a minute and try again.';
  if (/decommission|model_not_found|does not exist|no chat model|no vision/i.test(groq)) return "Groq's models changed. Open /api/health on your site to see which models are live.";
  if (/timeout/i.test(groq)) return 'The AI took too long to answer — please try again.';
  return 'Open /api/health on your site to see exactly what is failing.';
}

// ---- tiny Node request/response helpers (work on Vercel and in local tests) ----
async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return null; } }
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) { return null; }
}
function send(res, status, obj, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.keys(extraHeaders || {}).forEach(k => res.setHeader(k, extraHeaders[k]));
  res.end(JSON.stringify(obj));
}
function extractJson(text) {
  if (!text) return null;
  const clean = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(clean); } catch (_) {}
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

module.exports = { GROQ_BASE, TEXT_PREFERENCE, VISION_PREFERENCE, listModels, candidates, groqChat, timedFetch, hintFromErrors, readJson, send, extractJson, shorten };
