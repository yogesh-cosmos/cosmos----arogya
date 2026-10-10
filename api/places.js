'use strict';
// GET /api/places?lat=&lng=&radius=&category=  -> { elements, source, radiusUsed }
// GET /api/places?diag=1                        -> per-mirror self-test report
//
// Fix: previously the first mirror to reply was trusted even when it was EMPTY,
// so one mirror with no data hid hospitals that other mirrors had. Now every
// mirror is asked, the answer with the most places wins, and if nothing is found
// the radius is widened automatically (up to 15 km) before giving up.
const { timedFetch, send } = require('../lib/groq');

const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'CosmosArogya/1.0 (+https://github.com/; health-finder PWA)',
};
const MAX_RADIUS = 15000;

function buildQuery(lat, lng, radius, category) {
  const a = `(around:${radius},${lat},${lng})`;
  const both = (tag) => [`node${tag}${a}`, `way${tag}${a}`];
  let c;
  switch (category) {
    case 'hospital': c = both('["amenity"="hospital"]'); break;
    case 'pharmacy': c = both('["amenity"="pharmacy"]'); break;
    case 'dental':   c = both('["amenity"="dentist"]'); break;
    case 'clinic':   c = both('["amenity"="clinic"]'); break;
    case 'ortho':    c = both('["healthcare:speciality"~"orthop",i]').concat(both('["name"~"ortho|bone|joint|spine",i]["amenity"~"hospital|clinic|doctors"]')); break;
    case 'eye':      c = both('["healthcare:speciality"~"ophthalm|optom|eye",i]').concat(both('["healthcare"="optometrist"]'), both('["shop"="optician"]'), both('["name"~"eye|netra|vision|ophthal",i]["amenity"~"hospital|clinic|doctors"]')); break;
    default: c = both('["amenity"="hospital"]').concat(both('["amenity"="pharmacy"]'), both('["amenity"="dentist"]'), both('["amenity"="clinic"]'));
  }
  return `[out:json][timeout:25];(${c.join(';')};);out center 120;`;
}

async function tryMirror(url, query, timeoutMs) {
  const start = Date.now();
  try {
    const r = await timedFetch(url, { method: 'POST', headers: HEADERS, body: 'data=' + encodeURIComponent(query) }, timeoutMs || 12000);
    const raw = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + raw.slice(0, 160));
    let data; try { data = JSON.parse(raw); } catch (_) { throw new Error('non-JSON response'); }
    if (!data || !Array.isArray(data.elements)) throw new Error('no elements field');
    return { ok: true, mirror: url, elements: data.elements, ms: Date.now() - start };
  } catch (e) {
    const msg = /abort|timeout/i.test(e.name + ' ' + e.message) ? `timed out after ${Date.now() - start}ms` : e.message;
    return { ok: false, mirror: url, error: msg, ms: Date.now() - start };
  }
}

// Ask every mirror at one radius; return the best successful answer.
async function searchAt(lat, lng, radius, category) {
  const query = buildQuery(lat, lng, radius, category);
  const results = await Promise.all(MIRRORS.map(m => tryMirror(m, query)));
  const ok = results.filter(r => r.ok);
  const best = ok.sort((a, b) => b.elements.length - a.elements.length)[0] || null;
  return { best, results };
}

async function diagnose() {
  const q = `[out:json][timeout:15];(node["amenity"="hospital"](around:5000,9.9252,78.1198););out center 3;`;
  const results = await Promise.all(MIRRORS.map(m => tryMirror(m, q, 9000)));
  const anyOk = results.some(r => r.ok);
  return {
    time: new Date().toISOString(),
    results: results.map(r => r.ok ? { mirror: r.mirror, ok: true, ms: r.ms, count: r.elements.length } : { mirror: r.mirror, ok: false, ms: r.ms, error: r.error }),
    verdict: anyOk
      ? 'At least one map mirror responded from this server, so the hospital finder can work. An empty list for a location means that area has few tagged places, and the search now widens automatically.'
      : 'All map mirrors failed from this server right now. See the per-mirror errors: 403 means blocked, timeout means unreachable, 429 means rate-limited.',
  };
}

module.exports = async function handler(req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (u.searchParams.get('diag') === '1') return send(res, 200, await diagnose());

  const lat = parseFloat(u.searchParams.get('lat')), lng = parseFloat(u.searchParams.get('lng'));
  const startRadius = Math.min(MAX_RADIUS, parseInt(u.searchParams.get('radius') || '6000', 10) || 6000);
  const category = u.searchParams.get('category') || 'all';
  if (!isFinite(lat) || !isFinite(lng)) return send(res, 400, { error: 'lat and lng query params required' });

  let radius = startRadius, attempt = await searchAt(lat, lng, radius, category);
  // Nothing found at this radius? Widen it once or twice before reporting "none".
  while (attempt.best && attempt.best.elements.length === 0 && radius < MAX_RADIUS) {
    radius = Math.min(MAX_RADIUS, Math.round(radius * 2.5));
    attempt = await searchAt(lat, lng, radius, category);
  }

  if (attempt.best) {
    return send(res, 200,
      { elements: attempt.best.elements, source: attempt.best.mirror, category, radiusUsed: radius },
      { 'Cache-Control': 'public, max-age=120' });
  }

  const details = attempt.results.map(r => `${r.mirror}: ${r.error}`);
  const allForbidden = attempt.results.every(r => /HTTP 403/.test(r.error || ''));
  const allTimedOut = attempt.results.every(r => /timed out/.test(r.error || ''));
  const hint = allForbidden
    ? 'All map servers rejected the request (403). Open /api/places?diag=1 for details.'
    : allTimedOut
    ? 'Map servers timed out. Try again shortly.'
    : 'Map data is temporarily unavailable. Open /api/places?diag=1 for the exact reason.';
  return send(res, 503, { error: 'Could not load nearby places right now.', hint, details });
};
