'use strict';
// POST /api/brand-research { medicineName, activeIngredient, lang } -> ranked comparison
// A RELATIVE ranking of the scanned brand against 3-5 alternatives with the same active
// ingredient, from the model's general pharmaceutical knowledge. It is NOT a market-wide
// "top 20" (no objective source for that exists) and NOT live data; the response says so.
const { groqChat, hintFromErrors, readJson, send, extractJson } = require('../lib/groq');

const LANGS = { en: 'English', ta: 'Tamil', hi: 'Hindi', te: 'Telugu', ml: 'Malayalam' };
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const body = await readJson(req);
  if (!body || !body.medicineName) return send(res, 400, { error: 'medicineName required' });
  const { medicineName, activeIngredient } = body;
  const L = LANGS[body.lang] || 'English';

  const prompt = `The user scanned a medicine branded "${medicineName}"${activeIngredient ? ` (active ingredient: ${activeIngredient})` : ''}.
Produce a RANKED comparison of this brand against 3-5 OTHER real, commonly available brands with the SAME active ingredient.
Score each brand 1-10 on: manufacturerScale (large well-known multinational high; regional lower; unknown lowest), trackRecord (how long-established/consistently available), regulatoryStanding (10 unless you are CONFIDENT of a real, well-known recall/warning — never invent one), transparency (manufacturer clearly identifiable).
overallScore = average of the four, 1 decimal. Rank all brands (including "${medicineName}") high to low. If you cannot tell two apart, give equal scores.
Reply with ONLY this JSON (no markdown):
{"scannedBrand":"${medicineName}","activeIngredient":"...","ranking":[{"rank":1,"brand":"...","isScannedBrand":false,"manufacturer":"name or null","manufacturerCountry":"country or null","scores":{"manufacturerScale":0,"trackRecord":0,"regulatoryStanding":0,"transparency":0},"overallScore":0.0,"note":"one short sentence in ${L}"}],"scannedBrandSummary":"1-2 sentences in ${L} on where the scanned brand landed and why; if it is top 2 say it is a strong choice; if lower, say alternatives may be worth asking a pharmacist about, without alarm","confidenceNote":"one honest sentence in ${L} about how confident this is (say so if some brands are little-known to you)","disclaimer":"one sentence in ${L}: general knowledge, not live market data or an official ranking, only among these brands; confirm with a pharmacist before switching"}
List 4-6 brands total. All text in ${L}. If you do not recognise the scanned brand, still list alternatives you know, set its manufacturer to null and say so in scannedBrandSummary.`;

  try {
    const r = await groqChat({
      key: process.env.GROQ_API_KEY, kind: 'text', maxTokens: 3500, timeoutMs: 28000,
      messages: [
        { role: 'system', content: 'You are a careful medical-information assistant. You never invent facts (recalls, manufacturers, false precision); you say when you are unsure and score conservatively. You only compare the specific brands you list, never claim to cover the whole market.' },
        { role: 'user', content: prompt },
      ],
    });
    const parsed = extractJson(r.text);
    if (!parsed || !Array.isArray(parsed.ranking) || !parsed.ranking.length) return send(res, 502, { error: 'Could not read the ranking result', hint: 'Try scanning again.' });

    parsed.ranking.forEach(item => {
      const s = item.scores || {};
      const parts = ['manufacturerScale', 'trackRecord', 'regulatoryStanding', 'transparency'].map(k => num(s[k])).filter(x => x > 0);
      let overall = num(item.overallScore);
      if (!overall && parts.length) overall = parts.reduce((a, b) => a + b, 0) / parts.length;
      item.overallScore = Math.round(Math.min(10, Math.max(0, overall)) * 10) / 10;
      item.isScannedBrand = item.isScannedBrand === true || String(item.brand || '').toLowerCase() === String(medicineName).toLowerCase();
    });
    parsed.ranking.sort((a, b) => b.overallScore - a.overallScore);
    parsed.ranking.forEach((item, i) => { item.rank = i + 1; });
    return send(res, 200, parsed);
  } catch (e) {
    return send(res, 502, { error: 'Brand ranking unavailable', hint: hintFromErrors(e.details || [String(e.message)]), details: e.details || [String(e.message)] });
  }
};
