'use strict';
// GET /api/places?lat=&lng=&radius=&category=  -> { elements:[...] } from OpenStreetMap (Overpass).
// Free, no key. Public Overpass servers are flaky, so 4 mirrors are raced in parallel and the
// first good answer wins. Each category builds a different targeted query.
const { timedFetch, send } = require('../lib/groq');

const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

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

async function tryMirror(url, query) {
  const r = await timedFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query) }, 9000);
  if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
  const d = await r.json();
  if (!d || !Array.isArray(d.elements)) throw new Error(url + ' bad response');
  return { data: d, mirror: url };
}

module.exports = async function handler(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const lat = parseFloat(u.searchParams.get('lat')), lng = parseFloat(u.searchParams.get('lng'));
  const radius = Math.min(15000, parseInt(u.searchParams.get('radius') || '6000', 10) || 6000);
  const category = u.searchParams.get('category') || 'all';
  if (!isFinite(lat) || !isFinite(lng)) return send(res, 400, { error: 'lat and lng query params required' });
  const query = buildQuery(lat, lng, radius, category);
  try {
    const win = await Promise.any(MIRRORS.map(m => tryMirror(m, query)));
    return send(res, 200, { elements: win.data.elements, source: win.mirror, category }, { 'Cache-Control': 'public, max-age=120' });
  } catch (agg) {
    return send(res, 503, { error: 'Map data servers are busy right now. Please retry in a moment.', details: (agg.errors || []).map(e => e.message) });
  }
};
