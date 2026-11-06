// HeadCount global counter, stored in Netlify Blobs (no database to set up).
//
// GET  /api/count              -> { people, members, regions:{CC:n}, you:bool }
// POST /api/count {id,hh,reg}  -> same shape, after adding/updating this device
//
// Design (Option A): fast and cheap. We keep ONE aggregate document, not a row
// per person. Each device sends a stable random id; we remember the last ~20000
// ids we've seen so a repeat tap from the same phone doesn't double-count within
// that window. This counts participants, not a perfect census - and the app says so.

import { getStore } from '@netlify/blobs';

const KEY = 'agg';
const SEEN_CAP = 20000;      // how many recent device ids we remember for dedupe
const MAX_HH = 30;           // sane cap on household size

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

async function readAgg(store) {
  try {
    const a = await store.get(KEY, { type: 'json' });
    if (a && typeof a === 'object') {
      return {
        people: Number(a.people) || 0,
        members: Number(a.members) || 0,
        regions: (a.regions && typeof a.regions === 'object') ? a.regions : {},
        seen: Array.isArray(a.seen) ? a.seen : [],
        hh: (a.hh && typeof a.hh === 'object') ? a.hh : {},  // id -> last household size
      };
    }
  } catch {}
  return { people: 0, members: 0, regions: {}, seen: [], hh: {} };
}

function publicShape(agg, you) {
  return {
    people: agg.people,
    members: agg.members,
    regions: agg.regions,
    you: !!you,
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers });

  const store = getStore('headcount');

  if (req.method === 'GET') {
    const agg = await readAgg(store);
    return new Response(JSON.stringify(publicShape(agg, false)), { headers });
  }

  if (req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch {}
    const id  = cleanId(body.id);
    const reg = cleanReg(body.reg);
    const hh  = cleanHh(body.hh);
    if (!id) {
      return new Response(JSON.stringify({ error: 'no id' }), { status: 400, headers });
    }

    const agg = await readAgg(store);
    const known = agg.hh[id] !== undefined || agg.seen.includes(id);

    if (!known) {
      // brand-new device: add one person + their household to the totals
      agg.people += 1;
      agg.members += hh;
      agg.regions[reg] = (agg.regions[reg] || 0) + 1;
      agg.hh[id] = hh;
      agg.seen.push(id);
      if (agg.seen.length > SEEN_CAP) agg.seen = agg.seen.slice(-SEEN_CAP);
    } else if (agg.hh[id] !== undefined && agg.hh[id] !== hh) {
      // same device changed its household size: adjust members, keep people the same
      agg.members += (hh - agg.hh[id]);
      if (agg.members < agg.people) agg.members = agg.people;
      agg.hh[id] = hh;
    }

    await store.setJSON(KEY, agg);
    return new Response(JSON.stringify(publicShape(agg, true)), { headers });
  }

  return new Response(JSON.stringify({ error: 'method' }), { status: 405, headers });
};

export const config = { path: '/api/count' };
