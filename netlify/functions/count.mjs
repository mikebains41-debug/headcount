// HeadCount global counter, stored in Netlify Blobs (no database to set up).
//
// GET  /api/count              -> { people, members, regions:{CC:n} }
// POST /api/count {id,hh,reg?}  -> same shape, after adding/updating this device
//
// Country comes from Netlify's edge geo header (accurate, no GPS, no permission).
// The client may send a fallback `reg`, used only if the header is missing.

import { getStore } from '@netlify/blobs';

const KEY = 'agg';
const SEEN_CAP = 20000;
const MAX_HH = 30;

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const cleanId  = (s) => String(s || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
const cleanReg = (s) => String(s || 'ZZ').replace(/[^A-Z]/gi, '').toUpperCase().slice(0, 2) || 'ZZ';
const cleanHh  = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_HH, Math.max(1, v)) : 1;
};

function countryFrom(req, ctx) {
  try {
    const c = ctx && ctx.geo && ctx.geo.country && ctx.geo.country.code;
    if (c) return cleanReg(c);
  } catch {}
  const h = req.headers.get('x-country') || req.headers.get('x-nf-country') || '';
  if (h) return cleanReg(h);
  return '';
}

async function readAgg(store) {
  try {
    const a = await store.get(KEY, { type: 'json' });
    if (a && typeof a === 'object') {
      return {
        people: Number(a.people) || 0,
        members: Number(a.members) || 0,
        regions: (a.regions && typeof a.regions === 'object') ? a.regions : {},
        seen: Array.isArray(a.seen) ? a.seen : [],
        hh: (a.hh && typeof a.hh === 'object') ? a.hh : {},
        reg: (a.reg && typeof a.reg === 'object') ? a.reg : {},
      };
    }
  } catch {}
  return { people: 0, members: 0, regions: {}, seen: [], hh: {}, reg: {} };
}

const shape = (a) => ({ people: a.people, members: a.members, regions: a.regions });

export default async (req, ctx) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers });

  const store = getStore('headcount');

  if (req.method === 'GET') {
    const agg = await readAgg(store);
    return new Response(JSON.stringify(shape(agg)), { headers });
  }

  if (req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch {}
    const id = cleanId(body.id);
    const hh = cleanHh(body.hh);
    const reg = countryFrom(req, ctx) || cleanReg(body.reg);
    if (!id) return new Response(JSON.stringify({ error: 'no id' }), { status: 400, headers });

    const agg = await readAgg(store);
    const known = agg.hh[id] !== undefined || agg.seen.includes(id);

    if (!known) {
      agg.people += 1;
      agg.members += hh;
      agg.regions[reg] = (agg.regions[reg] || 0) + 1;
      agg.hh[id] = hh;
      agg.reg[id] = reg;
      agg.seen.push(id);
      if (agg.seen.length > SEEN_CAP) agg.seen = agg.seen.slice(-SEEN_CAP);
    } else {
      if (agg.hh[id] !== undefined && agg.hh[id] !== hh) {
        agg.members += (hh - agg.hh[id]);
        if (agg.members < agg.people) agg.members = agg.people;
        agg.hh[id] = hh;
      }
      const old = agg.reg[id];
      if (reg && reg !== 'ZZ' && old && old !== reg) {
        if (agg.regions[old]) { agg.regions[old] -= 1; if (agg.regions[old] <= 0) delete agg.regions[old]; }
        agg.regions[reg] = (agg.regions[reg] || 0) + 1;
        agg.reg[id] = reg;
      }
    }

    await store.setJSON(KEY, agg);
    return new Response(JSON.stringify({ ...shape(agg), country: agg.reg[id] || reg }), { headers });
  }

  return new Response(JSON.stringify({ error: 'method' }), { status: 405, headers });
};

export const config = { path: '/api/count' };
