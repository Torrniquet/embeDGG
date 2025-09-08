/**
 *  @file background.js (service worker)
 *
 * This is the extension's background service worker. It runs independently of
 * the page and is responsible for:
 * - Storing and serving user settings (enableTweets, enableMedia, etc.).
 * - Performing cross‑origin fetches that the content script cannot do because
 *   of the page's CSP (e.g., YouTube oEmbed, Twitter widget CDN, Fx/VxTwitter).
 * - Normalizing Twitter/X tweet data so the content script can render a simple
 *   card without worrying about API differences.
 *
 * The content script talks to this worker via chrome.runtime.sendMessage.
 * Each handler below returns a simple JSON payload to keep the content script
 * small and focused on rendering.
 *
 * User‑visible feature toggles with their default values. We merge these with
 * anything the user already has saved in chrome.storage on install.
 */
const DEFAULTS = {
  enableTweets: true,
  enableMedia: true,
  enableYouTube: true,
  enableTwitch: true,
  enableKick: true,
  enableInstagram: true,
  blurMedia: false
};

// Initialize defaults on install
// Seed settings on first install (or keep existing on update).
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get();
  await chrome.storage.sync.set({ ...DEFAULTS, ...current });
});

// Utility: simple domain whitelist (exact host or suffix match where specified)
// Minimal allowlist for background fetches. This is intentionally smaller than
// the content script's, and only includes hosts where we actually need the
// background to fetch (because of page CSP and/or CORS restrictions).
const MEDIA_WHITELIST = new Set([
  "imgur.com","i.imgur.com","flickr.com","www.flickr.com","youtube.com","www.youtube.com",
  "youtu.be","vimeo.com","instagram.com","www.instagram.com","ddinstagram.com",
  "www.ddinstagram.com","giphy.com","media.giphy.com","tenor.com","media.tenor.com",
  "streamable.com","dropbox.com","onedrive.live.com","photos.google.com",
  "lh3.googleusercontent.com","icloud.com","res.cloudinary.com","s3.amazonaws.com",
  "cdn.discordapp.com","i.4cdn.org","kick.com","twitch.tv","www.twitch.tv",
  "i.kym-cdn.com",
  "twitter.com","x.com","t.co","fxtwitter.com","nitter.net"
]);

// Background fetch with CORS bypass (where allowed by host_permissions)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Generic background fetch for simple text/JSON pages the content script
  // wants to inspect (e.g., Imgur HTML to extract og:image).
  if (msg?.type === "bgFetch") {
    (async () => {
      try {
        const url = new URL(msg.url);
        if (!MEDIA_WHITELIST.has(url.hostname)) {
          return sendResponse({ ok: false, error: "blocked_by_whitelist" });
        }
        const res = await fetch(msg.url, { credentials: "omit", cache: "no-store", mode: "cors" });
        const contentType = res.headers.get("content-type") || "";
        const text = contentType.includes("application/json") ? await res.text() : await res.text();
        // Expose the final URL after redirects so callers can resolve shortlinks (e.g., t.co)
        const finalUrl = res.url || msg.url;
        sendResponse({ ok: res.ok, status: res.status, contentType, body: text, finalUrl });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // keep channel open for async sendResponse
  }

  // Expose saved settings to the content script.
  if (msg?.type === "getSettings") {
    (async () => {
      const cfg = await chrome.storage.sync.get();
      sendResponse({ ok: true, settings: { ...DEFAULTS, ...cfg } });
    })();
    return true;
  }

  // Persist changed settings and broadcast to all tabs so they can re‑read.
  if (msg?.type === "setSettings") {
    (async () => {
      await chrome.storage.sync.set(msg.settings || {});
      // Broadcast to all tabs so content script can hot-apply new behavior for future messages
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        try {
          if (tab.id) chrome.tabs.sendMessage(tab.id, { type: "settingsUpdated" });
        } catch {}
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Fetch YouTube oEmbed so content script can render a thumbnail/title card
  // without trying to inject an iframe (commonly blocked by CSP).
  if (msg?.type === "oembed" && msg?.provider === "youtube" && typeof msg?.videoUrl === "string") {
    (async () => {
      try {
        const url = new URL(msg.videoUrl);
        // Only allow YouTube URLs for this oEmbed path
        if (!(url.hostname.endsWith("youtube.com") || url.hostname === "youtu.be")) {
          return sendResponse({ ok: false, error: "invalid_provider" });
        }
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(msg.videoUrl)}&format=json`;
        const res = await fetch(oembedUrl, { credentials: "omit", cache: "no-store", mode: "cors" });
        if (!res.ok) return sendResponse({ ok: false, status: res.status });
        const json = await res.json();
        sendResponse({ ok: true, data: json });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  // Resolve and normalize a Twitter/X tweet for a given URL. We first try the
  // official widget CDN JSON (works without API keys), then enrich/repair
  // using Fx/VxTwitter to extract direct media URLs for reliable rendering.
  if (msg && msg.type === 'fetchTweet') {
    const rawUrl = String(msg.url || '');

    // Pull the numeric tweet ID out of any supported URL shape.
    function extractTweetId(u) {
      try {
        const url = new URL(u);
        // Support /status/<id> and /i/web/status/<id>
        const m = url.pathname.match(/\/status\/(\d+)/) || url.pathname.match(/\/i\/web\/status\/(\d+)/);
        return m ? m[1] : null;
      } catch (_) {
        return null;
      }
    }

    const id = extractTweetId(rawUrl);
    const cdnById = id ? `https://cdn.syndication.twimg.com/widgets/tweet?id=${encodeURIComponent(id)}&dnt=true` : null;
    const cdnByUrl = `https://cdn.syndication.twimg.com/widgets/tweet?url=${encodeURIComponent(rawUrl)}&dnt=true`;
    const oembedUrl = `https://publish.twitter.com/oembed?omit_script=1&hide_thread=1&align=left&dnt=true&url=${encodeURIComponent(rawUrl)}`;

    (async () => {
      try {
        // Try to extract photo/video URLs via Fx/VxTwitter. We don't depend on
        // their schema — we walk the JSON for any pbs.twimg.com or
        // video.twimg.com links and normalize them for the content script.
        async function enrichFromFxVx(tid) {
          const out = { photos: [], videos: [], text: '' };
          if (!tid) return out;

          // Try FX first
          const tryUrls = [
            `https://fxtwitter.com/i/status/${encodeURIComponent(tid)}.json`,
            `https://api.vxtwitter.com/Twitter/status/${encodeURIComponent(tid)}`,
            `https://vxtwitter.com/i/status/${encodeURIComponent(tid)}.json`
          ];

          for (const u of tryUrls) {
            try {
              const resp = await fetch(u, { credentials: 'omit', cache: 'no-cache' });
              if (!resp.ok) continue;
              const j = await resp.json();

              // Try to capture tweet text if provided in common fields
              try {
                const t = (typeof j.text === 'string' && j.text)
                  || (j.tweet && (typeof j.tweet.full_text === 'string' && j.tweet.full_text))
                  || (j.tweet && (typeof j.tweet.text === 'string' && j.tweet.text))
                  || '';
                if (t && !out.text) out.text = String(t);
              } catch {}

              // Heuristic scan for direct media URLs
              const scan = (obj) => {
                const photos = [];
                const videos = [];
                const walk = (v) => {
                  if (!v) return;
                  if (typeof v === 'string') {
                    const s = v;
                    if (/^https?:\/\/pbs\.twimg\.com\/media\//.test(s) && /\.(?:jpg|jpeg|png|gif|webp)(?:$|\?)/i.test(s)) {
                      photos.push(s);
                    }
                    if (/^https?:\/\/video\.twimg\.com\//.test(s) && /\.mp4(?:$|\?)/i.test(s)) {
                      videos.push({ url: s, type: 'video/mp4' });
                    }
                    return;
                  }
                  if (Array.isArray(v)) { v.forEach(walk); return; }
                  if (typeof v === 'object') {
                    for (const k in v) walk(v[k]);
                  }
                };
                walk(obj);
                return { photos, videos };
              };

              const collected = scan(j);
              if (collected.photos.length || collected.videos.length) {
                // Deduplicate while preserving order
                const seenP = new Set();
                const seenV = new Set();
                out.photos.push(...collected.photos.filter(p => !seenP.has(p) && seenP.add(p)));
                out.videos.push(...collected.videos.filter(v => {
                  const key = v.url;
                  if (seenV.has(key)) return false;
                  seenV.add(key);
                  return true;
                }));
                break; // got what we need
              }
            } catch (_) { /* try next */ }
          }

          return out;
        }
        // Prefer CDN by id (most reliable), then fall back to by‑URL.
        const first = cdnById || cdnByUrl;
        let r = await fetch(first, { credentials: 'omit', cache: 'no-cache' });
        if (!r.ok && first !== cdnByUrl) {
          r = await fetch(cdnByUrl, { credentials: 'omit', cache: 'no-cache' });
        }
        if (r.ok) {
          const data = await r.json();
          const normalized = {
            user: data.user || null,
            author_name: data.author_name || (data.user && (data.user.name || data.user.screen_name)) || '',
            text: data.text || data.full_text || data.description || '',
            created_at: data.created_at || data.date || '',
            entities: data.entities || null,
            photos: Array.isArray(data.photos)
              ? data.photos
              : (data.entities && Array.isArray(data.entities.media) ? data.entities.media : [])
          };

          // Enrich with media (esp. videos) via fxtwitter/vxtwitter if needed.
          try {
            const extra = await enrichFromFxVx(id);
            if (extra && (extra.photos.length || extra.videos.length)) {
              // Merge photos
              const existingPhotoUrls = new Set();
              const photoObjs = Array.isArray(normalized.photos) ? normalized.photos.slice() : [];
              photoObjs.forEach(p => {
                if (!p) return;
                let pu = null;
                if (typeof p === 'string') pu = p; else if (p.url) pu = p.url; else if (p.media_url_https) pu = p.media_url_https; else if (p.media_url) pu = p.media_url;
                if (pu) existingPhotoUrls.add(pu);
              });
              for (const pu of extra.photos) {
                if (!existingPhotoUrls.has(pu)) photoObjs.push({ url: pu });
              }
              normalized.photos = photoObjs;

              // Attach videos in normalized form
              normalized.videos = extra.videos;

              // If CDN JSON didn't include text, try to use Fx/Vx text
              if ((!normalized.text || !String(normalized.text).trim()) && extra.text) {
                normalized.text = extra.text;
              }
            }
          } catch (_) { /* non-fatal */ }

          // If no text found, try fetching oEmbed HTML to extract text later in content script
          try {
            if (!normalized.text || String(normalized.text).trim() === '') {
              const oe2 = await fetch(oembedUrl, { credentials: 'omit', cache: 'no-cache' });
              if (oe2.ok) {
                const od2 = await oe2.json();
                if (od2 && od2.html) normalized.oembed_html = od2.html;
              }
            }
          } catch {}

          sendResponse({ ok: true, source: 'cdn', data: Object.assign({}, data, normalized) });
          return;
        }

        // If CDN failed, try enriching via fxtwitter/vxtwitter by id only.
        try {
          const extra = await enrichFromFxVx(id);
          if (extra && (extra.photos.length || extra.videos.length)) {
            const minimal = {
              user: null,
              author_name: '',
              text: extra.text || '',
              created_at: '',
              entities: null,
              photos: extra.photos.map(u => ({ url: u })),
              videos: extra.videos
            };
            sendResponse({ ok: true, source: 'vx', data: minimal });
            return;
          }
        } catch (_) { /* ignore and continue */ }

        // Fallback: publish.twitter.com oEmbed HTML; we'll render in content.js
        const oe = await fetch(oembedUrl, { credentials: 'omit', cache: 'no-cache' });
        if (!oe.ok) {
          sendResponse({ ok: false, error: `Error: HTTP ${oe.status}` });
          return;
        }
        const odata = await oe.json();
        sendResponse({ ok: true, source: 'oembed', data: { html: odata.html || '', author_name: odata.author_name || '', url: rawUrl } });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();

    return true; // async
  }
});
