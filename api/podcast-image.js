// Vercel serverless function — resolves the Freedom to Thrive podcast's CURRENT
// artwork from its Podbean RSS feed, so the displayed logo stays correct even
// when it's swapped out in Podbean. Redirects (302) to the live image URL, so
// the frontend can just use <img src="/api/podcast-image">.
//
// ?fresh=1 bypasses the 30-min cache and re-reads the feed immediately.

let cache = { url: null, at: 0 };
const CACHE_MS = 30 * 60 * 1000; // 30 minutes

const FEED_URL = "https://feed.podbean.com/freedomtothrive/feed.xml";

// Last-known-good logo (as of 2026-07) — only used if the feed can't be read.
const FALLBACK_IMAGE =
  "https://pbcdn1.podbean.com/imglogo/image-logo/18566081/F2T_New_Logo_Resize7lfua.jpeg";

// Pull the channel-level artwork URL out of the RSS XML. Restricts the search
// to the channel metadata (before the first <item>) so per-episode images can't
// win. Prefers <itunes:image href="…">, falls back to <image><url>…</url>.
function extractImageUrl(xml) {
  const channel = xml.split(/<item[\s>]/i)[0];
  const itunes = channel.match(/<itunes:image[^>]*\bhref\s*=\s*["']([^"']+)["']/i);
  if (itunes) return itunes[1].trim();
  const img = channel.match(/<image>[\s\S]*?<url>\s*([^<\s]+)\s*<\/url>/i);
  if (img) return img[1].trim();
  return null;
}

export default async function handler(req, res) {
  const bypass = req.query?.fresh === '1';
  const now = Date.now();

  let url = (!bypass && cache.url && now - cache.at < CACHE_MS) ? cache.url : null;

  if (!url) {
    try {
      const resp = await fetch(FEED_URL, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CalendarFetcher/1.0)' },
      });
      if (resp.ok) {
        const parsed = extractImageUrl(await resp.text());
        if (parsed) {
          url = parsed;
          cache = { url, at: now };
        }
      }
    } catch { /* fall through to fallback below */ }
  }

  if (!url) url = cache.url || FALLBACK_IMAGE;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', bypass ? 'no-store' : 'public, max-age=1800');
  res.setHeader('Location', url);
  res.statusCode = 302;
  res.end();
}
