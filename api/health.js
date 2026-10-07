'use strict';
// GET /api/health — open this URL in a browser to see exactly what is (not) working.
// Never prints the key itself, only whether it exists and looks well-formed.
const { listModels, candidates, groqChat, hintFromErrors, send } = require('../lib/groq');

module.exports = async function handler(req, res) {
  const key = process.env.GROQ_API_KEY || '';
  const out = {
    time: new Date().toISOString(),
    env: {
      GROQ_API_KEY: key ? 'set' : 'MISSING',
      keyLooksValid: key ? /^gsk_[A-Za-z0-9]{20,}$/.test(key.trim()) : false,
      keyHasWhitespace: key ? key !== key.trim() : false,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'set (optional)' : 'not set (optional)',
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ? 'set (optional)' : 'not set (optional)',
    },
    groq: {},
  };
  if (!key) {
    out.verdict = "GROQ_API_KEY is missing. Vercel → your project → Settings → Environment Variables → add GROQ_API_KEY, then redeploy once.";
    return send(res, 200, out);
  }
  const ids = await listModels(key.trim());
  out.groq.modelsReachable = !!ids;
  out.groq.liveChatModels = ids ? ids.filter(i => !/whisper|orpheus|tts|guard|safeguard|embed/i.test(i)) : null;
  out.groq.textModelsToTry = candidates(ids, 'text');
  out.groq.visionModelsToTry = candidates(ids, 'vision');
  try {
    const r = await groqChat({ key: key.trim(), kind: 'text', maxTokens: 400, timeoutMs: 15000, messages: [{ role: 'user', content: 'Reply with the single word: OK' }] });
    out.groq.testChat = 'PASS via ' + r.model;
    out.verdict = out.groq.visionModelsToTry.length
      ? 'All good — chat works and a vision model is available for the scanner.'
      : 'Chat works, but no vision-capable Groq model is available, so the image scanner cannot read pictures (voice/typed medicine names still work).';
  } catch (e) {
    out.groq.testChat = 'FAIL';
    out.groq.error = e.details || [String(e.message)];
    out.verdict = hintFromErrors(e.details || [String(e.message)]);
  }
  return send(res, 200, out);
};
