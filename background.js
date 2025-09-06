
// background.js (service worker)
const DEFAULTS = {
  enableTweets: true,
  enableMedia: true,
  enableYouTube: true,
  enableTwitch: true,
  renderOnHover: false, // default: no hover required,
  enableHoverPreview: true,
  blurMedia: false
};

// Initialize defaults on install
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get();
  await chrome.storage.sync.set({ ...DEFAULTS, ...current });
});

// Utility: simple domain whitelist (exact host or suffix match where specified)
const MEDIA_WHITELIST = new Set([
  "imgur.com","i.imgur.com","flickr.com","www.flickr.com","youtube.com","www.youtube.com",
  "youtu.be","vimeo.com","giphy.com","media.giphy.com","tenor.com","media.tenor.com",
  "streamable.com","dropbox.com","onedrive.live.com","photos.google.com",
  "lh3.googleusercontent.com","icloud.com","res.cloudinary.com","s3.amazonaws.com",
  "cdn.discordapp.com","i.4cdn.org","kick.com","twitch.tv","www.twitch.tv",
  "twitter.com","x.com","fxtwitter.com","nitter.net"
]);

// Background fetch with CORS bypass (where allowed by host_permissions)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
        sendResponse({ ok: res.ok, status: res.status, contentType, body: text });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // keep channel open for async sendResponse
  }

  if (msg?.type === "getSettings") {
    (async () => {
      const cfg = await chrome.storage.sync.get();
      sendResponse({ ok: true, settings: { ...DEFAULTS, ...cfg } });
    })();
    return true;
  }

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

  if (msg && msg.type === 'fetchTweet') {
    const rawUrl = String(msg.url || '');

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
        // Prefer CDN by id, then by url
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
          sendResponse({ ok: true, source: 'cdn', data: Object.assign({}, data, normalized) });
          return;
        }

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
