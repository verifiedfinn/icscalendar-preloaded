// Vercel serverless function — proxies Hector's personal Google Calendar ICS.
// The real URL lives in HECTOR_PERSONAL_ICS_URL (env var, never sent to browser).
// Callers must supply:  Authorization: Bearer <APP_PASSWORD>

let cache = { ics: null, at: 0 };
const CACHE_MS = 30 * 60 * 1000; // 30 minutes

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  const expected = `Bearer ${process.env.APP_PASSWORD}`;
  if (!process.env.APP_PASSWORD || req.headers['authorization'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const url = process.env.HECTOR_PERSONAL_ICS_URL;
  if (!url) {
    return res.status(503).json({ error: 'HECTOR_PERSONAL_ICS_URL not configured' });
  }

  const now = Date.now();
  if (cache.ics && now - cache.at < CACHE_MS) {
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(cache.ics);
  }

  let upstream;
  try {
    upstream = await fetch(url);
  } catch (err) {
    return res.status(502).json({ error: `Upstream fetch failed: ${err.message}` });
  }
  if (!upstream.ok) {
    return res.status(502).json({ error: `Upstream returned ${upstream.status}` });
  }

  const ics = await upstream.text();
  cache = { ics, at: now };

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(ics);
}
