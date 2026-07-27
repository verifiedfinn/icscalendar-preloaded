// Vercel serverless function — serves the Freedom to Thrive podcast's CURRENT
// artwork, resolved live from its Podbean RSS feed, so social/link previews
// (og:image) stay correct even when the logo is swapped out in Podbean.
//
// Serves the image BYTES directly (not a redirect) for maximum compatibility
// with link-preview crawlers (iMessage, Facebook, Twitter, Slack, Discord),
// which handle redirected og:image URLs unreliably.
//
// ?fresh=1 bypasses the 30-min cache and re-reads the feed immediately.

let urlCache = { url: null, at: 0 };
const CACHE_MS = 30 * 60 * 1000; // 30 minutes

const FEED_URL = "https://feed.podbean.com/freedomtothrive/feed.xml";

// Last-known-good logo (as of 2026-07) — only used if the feed can't be read.
const FALLBACK_IMAGE =
  "https://pbcdn1.podbean.com/imglogo/image-logo/18566081/F2T_New_Logo_Resize7lfua.jpeg";

const UA = 'Mozilla/5.0 (compatible; CalendarFetcher/1.0)';

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

// Resolve the current artwork URL from the feed, with a 30-min cache.
async function resolveImageUrl(bypass) {
  const now = Date.now();
  if (!bypass && urlCache.url && now - urlCache.at < CACHE_MS) return urlCache.url;
  try {
    const resp = await fetch(FEED_URL, { redirect: 'follow', headers: { 'User-Agent': UA } });
    if (resp.ok) {
      const parsed = extractImageUrl(await resp.text());
      if (parsed) { urlCache = { url: parsed, at: now }; return parsed; }
    }
  } catch { /* fall through to whatever we last had */ }
  return urlCache.url || FALLBACK_IMAGE;
}

export default async function handler(req, res) {
  const bypass = req.query?.fresh === '1';

  let imgUrl;
  try {
    imgUrl = await resolveImageUrl(bypass);
    const imgResp = await fetch(imgUrl, { redirect: 'follow', headers: { 'User-Agent': UA } });
    if (!imgResp.ok) throw new Error(`image HTTP ${imgResp.status}`);

    const buf = Buffer.from(await imgResp.arrayBuffer());
    res.setHeader('Content-Type', imgResp.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', bypass ? 'no-store' : 'public, max-age=1800');
    return res.send(buf);
  } catch {
    // Last resort: redirect to the URL we resolved so something still renders.
    res.setHeader('Location', imgUrl || FALLBACK_IMAGE);
    res.statusCode = 302;
    return res.end();
  }
}
