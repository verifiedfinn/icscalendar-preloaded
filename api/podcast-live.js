// Vercel serverless function — proxies Freedom to Thrive Podcast Google Calendar ICS.
// Avoids client-side CORS restrictions (Safari ITP, third-party blocking).

let cache = { ics: null, at: 0 };
const CACHE_MS = 30 * 60 * 1000; // 30 minutes

const PODCAST_ICS_URL =
  "https://calendar.google.com/calendar/ical/13a4368be555f7c3c3046a21be8e01dc698839e43160cb25d3385d50b3d1c0a5%40group.calendar.google.com/public/basic.ics";

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  const now = Date.now();
  if (cache.ics && now - cache.at < CACHE_MS) {
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    return res.send(cache.ics);
  }

  let upstream;
  try {
    upstream = await fetch(PODCAST_ICS_URL, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CalendarFetcher/1.0)' },
    });
  } catch (err) {
    return res.status(502).json({ error: `Upstream fetch failed: ${err.message}` });
  }

  if (!upstream.ok) {
    return res.status(502).json({ error: `Upstream returned ${upstream.status}: ${upstream.statusText}` });
  }

  const ics = await upstream.text();
  cache = { ics, at: now };

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=1800');
  res.send(ics);
}
