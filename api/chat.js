'use strict';
// POST /api/chat  { messages:[{role,content}], image?: dataUrl }  ->  { text, provider, model }
// Keys live only in Vercel env vars. Groq first (with live model discovery); Gemini /
// OpenRouter / a no-key text fallback are optional extras used only if Groq fails.
const { groqChat, timedFetch, hintFromErrors, readJson, send, shorten } = require('../lib/groq');

const SYSTEM_FALLBACK = 'You are Arogya AI, a compassionate multilingual medical assistant. Keep replies concise. Never diagnose — recommend consulting a doctor for anything serious.';

function withImage(messages, imageDataUrl) {
  const out = messages.map(m => Object.assign({}, m));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') {
      out[i] = { role: 'user', content: [{ type: 'text', text: out[i].content }, { type: 'image_url', image_url: { url: imageDataUrl } }] };
      break;
    }
  }
  return out;
}

async function viaGroq(messages, image) {
  const r = await groqChat({ key: process.env.GROQ_API_KEY, kind: image ? 'vision' : 'text', messages: image ? withImage(messages, image) : messages });
  return { text: r.text, model: r.model };
}

async function viaGemini(messages, image) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no-key');
  const sys = (messages.find(m => m.role === 'system') || {}).content || SYSTEM_FALLBACK;
  const lastUser = (messages.filter(m => m.role !== 'system').pop() || {}).content || '';
  const parts = [{ text: lastUser }];
  if (image) { const m = image.match(/^data:(image\/\w+);base64,(.+)$/); if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } }); }
  const r = await timedFetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], systemInstruction: { parts: [{ text: sys }] }, generationConfig: { temperature: 0.3, maxOutputTokens: 2000 } }),
  }, 20000);
  const raw = await r.text();
  if (!r.ok) throw new Error(r.status + ' ' + shorten(raw));
  const d = JSON.parse(raw);
  const text = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts.map(p => p.text || '').join('');
  if (!text) throw new Error('empty reply');
  return { text, model: 'gemini-2.5-flash' };
}

async function viaOpenRouter(messages, image) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('no-key');
  const model = process.env.OPENROUTER_MODEL || (image ? 'google/gemini-2.0-flash-exp:free' : 'meta-llama/llama-3.3-70b-instruct:free');
  const r = await timedFetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'X-Title': 'COSMOS Arogya' },
    body: JSON.stringify({ model, messages: image ? withImage(messages, image) : messages, temperature: 0.3, max_tokens: 1500 }),
  }, 20000);
  const raw = await r.text();
  if (!r.ok) throw new Error(r.status + ' ' + shorten(raw));
  const d = JSON.parse(raw);
  const text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!text) throw new Error('empty reply');
  return { text, model };
}

async function viaNoKey(messages, image) {
  if (image) throw new Error('no-vision-support');
  const sys = (messages.find(m => m.role === 'system') || {}).content || SYSTEM_FALLBACK;
  const lastUser = (messages.filter(m => m.role !== 'system').pop() || {}).content || '';
  const r = await timedFetch('https://text.pollinations.ai/openai', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai', messages: [{ role: 'system', content: sys }, { role: 'user', content: lastUser }] }),
  }, 8000);
  const raw = await r.text();
  if (!r.ok) throw new Error(r.status + ' ' + shorten(raw));
  const d = JSON.parse(raw);
  const text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!text) throw new Error('empty reply');
  return { text, model: 'pollinations' };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const body = await readJson(req);
  if (!body || !Array.isArray(body.messages)) return send(res, 400, { error: 'messages array required' });
  const image = typeof body.image === 'string' && body.image.indexOf('data:image') === 0 ? body.image : null;

  const providers = [['groq', viaGroq], ['gemini', viaGemini], ['openrouter', viaOpenRouter], ['fallback', viaNoKey]];
  const errors = [];
  for (const [name, fn] of providers) {
    try {
      const r = await fn(body.messages, image);
      return send(res, 200, { text: r.text, provider: name, model: r.model });
    } catch (e) {
      if (name === 'groq' && e.details) errors.push.apply(errors, e.details);
      else errors.push(name + ': ' + (e.message || e));
    }
  }
  return send(res, 503, { error: 'AI is temporarily unavailable.', hint: hintFromErrors(errors), details: errors });
};
