// Vercel serverless function — proxies Matt's public Google Calendar ICS.
// Avoids client-side CORS restrictions without relying on third-party proxies.

let cache = { ics: null, at: 0 };
const CACHE_MS = 30 * 60 * 1000; // 30 minutes

const MATT_ICS_URL =
  "https://calendar.google.com/calendar/ical/c_30bddbc5906cde0880bde664af52861bd707468edcadd75e921e8dabc6d6fd56%40group.calendar.google.com/public/basic.ics";

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
    upstream = await fetch(MATT_ICS_URL, {
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
