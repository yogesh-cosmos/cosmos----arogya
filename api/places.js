'use strict';
// GET /api/places?lat=&lng=&radius=&category=  -> { elements:[...] } from OpenStreetMap (Overpass).
// GET /api/places?diag=1                        -> tests all mirrors and reports exactly what each said.
// Free, no key. Public Overpass instances are known to reject requests with
// no descriptive User-Agent (a documented Overpass usage-policy requirement,
// and a common silent cause of 403s), and some mirrors throttle or block
// shared/datacenter IP ranges outright — which serverless platforms use.
// 4 mirrors are tried in parallel; the first good answer wins.
const { timedFetch, send } = require('../lib/groq');

const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

// Overpass's own usage policy asks clients to send a descriptive User-Agent
// identifying the application; several public mirrors return 403 for
// requests that don't. Costs nothing to include, fixes a real known cause.
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'CosmosArogya/1.0 (+https://github.com/; health-finder PWA)',
};

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
  return `[out:json][timeout:20];(${c.join(';')};);out center 80;`;
}

async function tryMirror(url, query, timeoutMs) {
  const start = Date.now();
  try {
    const r = await timedFetch(url, { method: 'POST', headers: HEADERS, body: 'data=' + encodeURIComponent(query) }, timeoutMs || 9000);
    const ms = Date.now() - start;
    const raw = await r.text();
    if (!r.ok) { const e = new Error('HTTP ' + r.status + ': ' + raw.slice(0, 160)); e.ms = ms; e.status = r.status; throw e; }
    let data;
    try { data = JSON.parse(raw); } catch (_) { const e = new Error('non-JSON response'); e.ms = ms; throw e; }
    if (!data || !Array.isArray(data.elements)) { const e = new Error('no elements field in response'); e.ms = ms; throw e; }
    return { data, mirror: url, ms };
  } catch (e) {
    e.ms = e.ms || (Date.now() - start);
    e.mirror = url;
    if (e.name === 'AbortError' || /timeout/i.test(e.message)) e.message = `timed out after ${e.ms}ms`;
    throw e;
  }
}

async function diagnose() {
  const testQuery = `[out:json][timeout:15];(node["amenity"="hospital"](around:3000,9.9252,78.1198););out center 3;`;
  const results = await Promise.all(MIRRORS.map(async m => {
    try { const r = await tryMirror(m, testQuery, 9000); return { mirror: m, ok: true, ms: r.ms, count: r.data.elements.length }; }
    catch (e) { return { mirror: m, ok: false, ms: e.ms, error: e.message }; }
  }));
  const anyOk = results.some(r => r.ok);
  return {
    time: new Date().toISOString(),
    results,
    verdict: anyOk
      ? 'At least one Overpass mirror is reachable from this server — the hospital finder should work. If it still shows nothing in the app, the issue is likely the browser not getting/sending your location, not this API.'
      : 'ALL 4 Overpass mirrors failed from this server right now. This usually means either Overpass is rate-limiting/blocking this server\'s shared IP address (common for free hosting platforms), or there is a network egress restriction on this deployment. See the per-mirror errors above for the exact reason — a 403 means blocked/rejected, a timeout means unreachable, a 429 means rate-limited.',
  };
}

module.exports = async function handler(req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (u.searchParams.get('diag') === '1') {
    const report = await diagnose();
    return send(res, 200, report);
  }

  const lat = parseFloat(u.searchParams.get('lat')), lng = parseFloat(u.searchParams.get('lng'));
  const radius = Math.min(15000, parseInt(u.searchParams.get('radius') || '6000', 10) || 6000);
  const category = u.searchParams.get('category') || 'all';
  if (!isFinite(lat) || !isFinite(lng)) return send(res, 400, { error: 'lat and lng query params required' });

  const query = buildQuery(lat, lng, radius, category);
  const attempts = MIRRORS.map(m => tryMirror(m, query).then(r => ({ ok: true, ...r }), e => ({ ok: false, mirror: m, error: e.message })));
  const results = await Promise.all(attempts);
  const win = results.find(r => r.ok);

  if (win) {
    return send(res, 200, { elements: win.data.elements, source: win.mirror, category }, { 'Cache-Control': 'public, max-age=120' });
  }

  const details = results.map(r => `${r.mirror}: ${r.error}`);
  const allForbidden = results.every(r => /HTTP 403/.test(r.error));
  const allTimedOut = results.every(r => /timed out/.test(r.error));
  const hint = allForbidden
    ? 'All map servers rejected the request (403) — likely this server\'s IP is being blocked by these free map providers. Visit /api/places?diag=1 for full details.'
    : allTimedOut
    ? 'All map servers timed out — they may be temporarily overloaded. Try again shortly, or visit /api/places?diag=1 for details.'
    : 'Map data is temporarily unavailable. Visit /api/places?diag=1 for the exact per-server reason.';

  return send(res, 503, { error: 'Could not load nearby places right now.', hint, details });
};
