
// content.js
(() => {
  const STATE = {
    settings: {
      enableTweets: true,
      enableMedia: true,
      enableYouTube: true,
      enableTwitch: true,
      renderOnHover: false,
      enableHoverPreview: true,
      blurMedia: false,
    }
  };
  // Maintains a temporary stick-to-bottom intent after user clicks DGG's "More messages below"
  STATE.stickyWanted = false; // when true, embeds will force-scroll to bottom even if height grows

  const MEDIA_EXT = /\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i;
  const MEDIA_WHITELIST = new Set([
    "cdn.syndication.twimg.com","destiny.gg/embed/chat*","twitter.com","pic.twitter.com",
    "x.com","nitter.net","fxtwitter.com","imgur.com","i.imgur.com","flickr.com",
    "youtube.com","youtu.be","vimeo.com","giphy.com","media.giphy.com","tenor.com",
    "media.tenor.com","streamable.com","dropbox.com","*.dropboxusercontent.com",
    "onedrive.live.com","photos.google.com","lh3.googleusercontent.com","icloud.com",
    "res.cloudinary.com","s3.amazonaws.com","cdn.discordapp.com","i.4cdn.org","kick.com",
    "twitch.tv","files.catbox.moe","destiny.gg/bigscreen*","packaged-media.redd.it","reddit.com",
    "i.redd.it","cdn.syndication.twimg.com","publish.twitter.com",
    "pbs.twimg.com","video.twimg.com"
  ]);

  function isTwitterImageUrl(u) {
    try {
      const h = u.hostname.toLowerCase().replace(/^www\./, '');
      if (h !== 'pbs.twimg.com') return false;
      const fmt = (u.searchParams.get('format') || '').toLowerCase();
      return fmt === 'jpg' || fmt === 'jpeg' || fmt === 'png' || fmt === 'webp' || fmt === 'gif';
    } catch { return false; }
  }

  function isTwitterVideoUrl(u) {
    try {
      const h = u.hostname.toLowerCase().replace(/^www\./, '');
      if (h !== 'video.twimg.com') return false;
      const path = u.pathname.toLowerCase();
      // common shapes: /ext_tw_video/<id>/pu/vid/<WxH>/<file>.mp4?tag=... OR /amplify_video/...
      return /\.mp4(?:$|\?)/.test(path) || /\/vid\//.test(path) || /\/mp4\//.test(path);
    } catch { return false; }
  }

  // Fetch settings from background
  chrome.runtime.sendMessage({ type: "getSettings" }, (res) => {
    if (res && res.ok) STATE.settings = { ...STATE.settings, ...res.settings };
    init();
  });

  // Update-on-change (apply for new messages only)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "settingsUpdated") {
      chrome.runtime.sendMessage({ type: "getSettings" }, (res) => {
        if (res && res.ok) STATE.settings = { ...STATE.settings, ...res.settings };
      });
    }
  });

  function init() {
    if (!location.href.startsWith("https://www.destiny.gg/embed/chat")) return;

    const chatRoot = document.body;
    if (!chatRoot) return;

    // Live stream of message nodes: observe additions
    const mo = new MutationObserver((muts) => {
      const nodes = [];
      for (const m of muts) {
        for (const n of m.addedNodes || []) {
          if (!(n instanceof HTMLElement)) continue;
          // destiny.gg chat lines usually are <div class="msg"> or similar — be permissive
          if (n.querySelectorAll) {
            nodes.push(n, ...n.querySelectorAll("div,li,p"));
          } else {
            nodes.push(n);
          }
        }
      }
      // Batch to avoid thrash
      if (nodes.length) processBatch(nodes);
    });
    mo.observe(chatRoot, { childList: true, subtree: true });

    // Retroactive on scroll into view: use IntersectionObserver limited to existing nodes
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          maybeEmbedInNode(e.target);
          io.unobserve(e.target);
        }
      }
    }, { root: null, rootMargin: "200px 0px", threshold: 0 });

    // Seed IO for any existing messages
    document.querySelectorAll("div,li,p").forEach(el => io.observe(el));

    function processBatch(nodes) {
      const uniq = Array.from(new Set(nodes.filter(n => n && n.nodeType === 1)));
      // If batching improves perf, we can microtask-yield; for MVP, process directly
      for (const el of uniq) {
        if (!document.contains(el)) continue;
        // Skip our own preview shell and injected wrappers
        if (el.id === 'edgg-hover-preview' || el.classList.contains('edgg-wrap')) continue;
        if (el.closest && (el.closest('#edgg-hover-preview') || el.closest('.edgg-wrap'))) continue;
        // Realtime embed for newly added messages
        maybeEmbedInNode(el);
      }
    }
    // Setup sticky bottom hook for DGG "More messages below"
    setupDggMoreBelowHook();
  }

  function findScrollableRoot() {
    // Prefer a dedicated scroll container if present; fallback to document.scrollingElement
    const candidates = Array.from(document.querySelectorAll('div, main, section'));
    for (const el of candidates) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
        return el;
      }
    }
    return document.scrollingElement || document.documentElement || document.body;
  }

  function setupDggMoreBelowHook() {
    const scroller = findScrollableRoot();

    // Keep STATE.stickyWanted in sync with user scroll position
    const onScroll = () => {
      try { STATE.stickyWanted = isAtBottom(scroller); } catch (_) {}
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // Observe for the ephemeral "More messages below" element and hook its click
    const attachIfNeeded = (root) => {
      const btn = Array.from(root.querySelectorAll('button,div,a'))
        .find(n => /more messages below/i.test(n.textContent || ''));
      if (btn && !btn.__edggHooked) {
        btn.__edggHooked = true;
        btn.addEventListener('click', () => {
          // Signal that the user wants to re-stick to bottom, then force-scroll
          STATE.stickyWanted = true;
          try { scrollToBottom(scroller); } catch (_) {}
          // Keep it sticky for a short grace window to survive async reflows
          clearTimeout(btn.__edggStickyTO);
          btn.__edggStickyTO = setTimeout(() => { STATE.stickyWanted = isAtBottom(scroller); }, 1000);
        }, true);
      }
    };

    // Initial scan
    attachIfNeeded(document);

    // Mutation observer to catch when the banner appears/disappears
    const mo2 = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.addedNodes) {
          m.addedNodes.forEach(n => { if (n.querySelector) attachIfNeeded(n); });
        }
      }
    });
    mo2.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function maybeEmbedInNode(el) {
    // Ignore our injected UI
    if (!el || (el.id === 'edgg-hover-preview') || (el.classList && el.classList.contains('edgg-wrap'))) return;
    if (el.closest && (el.closest('#edgg-hover-preview') || el.closest('.edgg-wrap'))) return;
    // Expect messages to contain anchor tags. If none, skip.
    const anchors = el.querySelectorAll ? el.querySelectorAll("a[href]") : [];
    if (!anchors.length) return;

    anchors.forEach(a => {
      tryEmbed(a, el);
    });
  }

  function isTweetUrlHost(hostname) {
    const h = (hostname || '').toLowerCase().replace(/^www\./, '');
    return (
      h === 'twitter.com' ||
      h === 'x.com' ||
      h === 'mobile.twitter.com' ||
      h === 'fxtwitter.com' ||
      h === 'vxtwitter.com' ||
      h === 'nitter.net'
    );
  }

  function tryEmbed(a, container) {
    const url = new URL(a.href, location.href);
    const host = url.hostname;

    // Require login heuristic: if chat shows "Log in" prominently, bail. (MVP heuristic)
    const pageText = (document.body && document.body.innerText ? document.body.innerText.toLowerCase() : "");
    if (pageText.includes("log in") && !pageText.includes("logout")) {
      return;
    }

    const isTweet = isTweetUrlHost(host) && (/\/status\/\d+/.test(url.pathname) || /\/i\/web\/status\/\d+/.test(url.pathname));
    const looksLikeMediaPath = MEDIA_EXT.test(url.pathname) || isTwitterImageUrl(url) || isTwitterVideoUrl(url);
    const isWhitelisted = MEDIA_WHITELIST.has(host) || isTwitterImageUrl(url) || isTwitterVideoUrl(url);

    // Compute embed width: chat container width minus username gutter; cap at 500px
    const { widthPx } = computeDesiredWidth(container);

    if (STATE.settings.enableTweets && isTweet && isWhitelisted) {
      const card = document.createElement('div');
      card.className = 'edgg-embed edgg-tweet';
      card.style.maxWidth = '500px';
      card.style.width = widthPx + 'px';
      card.innerHTML = `<div class="edgg-tweet-body"><div class="edgg-tweet-line">Loading tweet…</div></div>`;
      injectBelow(container, card, a.href, widthPx);

      chrome.runtime.sendMessage({ type: 'fetchTweet', url: a.href }, (res) => {
        if (!res || !res.ok || !res.data) {
          card.querySelector('.edgg-tweet-body').innerHTML =
            '<div class="edgg-tweet-line"><a class="edgg-tweet-link" href="' + a.href + '" target="_blank" rel="noopener noreferrer">' + a.href + '</a></div>';
          return;
        }
        try {
          if (res.source === 'oembed' && res.data && res.data.html) {
            // Parse the blockquote HTML to extract tweet text+links safely
            var tmp = document.createElement('div');
            tmp.innerHTML = res.data.html;
            var bq = tmp.querySelector('blockquote');
            var textHtml = '';
            var userName = res.data.author_name || '';
            if (bq) {
              var p = bq.querySelector('p');
              if (p) textHtml = p.innerHTML; // already contains <a> anchors for links
            }
            if (!textHtml) {
              textHtml = '<a href="' + a.href + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(a.href) + '</a>';
            }
            var bodyEl = card.querySelector('.edgg-tweet-body');

            // Attempt to extract media from the oEmbed blockquote
            var mediaNodes = [];
            if (bq) {
              var anchors = bq.querySelectorAll('a');
              for (var i = 0; i < anchors.length; i++) {
                var aTag = anchors[i];
                var expanded = aTag.getAttribute('data-expanded-url') || aTag.getAttribute('href') || '';
                try {
                  var eu = new URL(expanded, location.href);
                  var h = eu.hostname.toLowerCase().replace(/^www\./, '');
                  var path = eu.pathname.toLowerCase();
                  // Inline images from pbs.twimg.com (Twitter media CDN)
                  if (h === 'pbs.twimg.com' && /\.(jpg|jpeg|png|webp|gif)(?:$|\?)/.test(path)) {
                    var img = document.createElement('img');
                    img.className = 'edgg-media edgg-tweet-photo';
                    img.loading = 'lazy';
                    img.decoding = 'async';
                    img.src = eu.href;
                    mediaNodes.push(img);

                    // If this was a pic.twitter.com shortlink, drop it from the text
                    var hrefHost = (new URL(aTag.href, location.href)).hostname.replace(/^www\./,'');
                    if (/^pic\.twitter\.com$/i.test(hrefHost)) {
                      if (textHtml) {
                        var anchorHtml = aTag.outerHTML;
                        textHtml = textHtml.replace(anchorHtml, '');
                      }
                    }
                  }
                  // Basic MP4 support from video.twimg.com
                  if (h === 'video.twimg.com' && /\.(mp4)(?:$|\?)/.test(path)) {
                    var vid = document.createElement('video');
                    vid.className = 'edgg-media edgg-tweet-video';
                    vid.controls = true; // require interaction
                    vid.preload = 'metadata';
                    vid.playsInline = true;
                    var srcEl = document.createElement('source');
                    srcEl.src = eu.href;
                    srcEl.type = 'video/mp4';
                    vid.appendChild(srcEl);
                    mediaNodes.push(vid);
                  }
                } catch (_) { /* ignore bad URLs */ }
              }
            }

            var mediaHtml = '';
            if (mediaNodes.length) {
              var wrap = document.createElement('div');
              wrap.className = 'edgg-tweet-media';
              for (var mi = 0; mi < mediaNodes.length && mi < 4; mi++) wrap.appendChild(mediaNodes[mi]);
              mediaHtml = wrap.outerHTML;
            }

          bodyEl.innerHTML =
            '<div class="edgg-tweet-header">' + (userName ? '<span class="edgg-tweet-user">' + escapeHtml(userName) + '</span>' : '') + '</div>' +
            '<div class="edgg-tweet-text">' + textHtml + '</div>' +
            mediaHtml +
            '<div class="edgg-tweet-footer"><a href="' + a.href + '" target="_blank" rel="noopener noreferrer">Open on Twitter</a></div>';

          // Keep bottom lock if images/videos load later
          var scrollerX = getScrollContainer(card);
          var imgsX = bodyEl.querySelectorAll('img,video');
          for (var xi = 0; xi < imgsX.length; xi++) {
            var elX = imgsX[xi];
            var evName = elX.tagName === 'VIDEO' ? 'loadedmetadata' : 'load';
            elX.addEventListener(evName, function(){ if (isAtBottom(scrollerX)) scrollToBottom(scrollerX); }, { once: true });
          }

          // Apply spoiler overlays on tweet media if enabled
          if (STATE.settings.blurMedia) {
            try { applySpoilersInRoot(bodyEl); } catch (_) {}
          }
          return;
        }

          // Preferred path: CDN JSON
          renderTweetInto(card, res.data, a.href);
        } catch (e) {
          card.querySelector('.edgg-tweet-body').innerHTML =
            '<div class="edgg-tweet-line"><a class="edgg-tweet-link" href="' + a.href + '" target="_blank" rel="noopener noreferrer">' + a.href + '</a></div>';
        }
      });
    }

    // Media embedding (images/videos) — only if clearly direct file or known CDN patterns (path ends with extension)
    if (STATE.settings.enableMedia && isWhitelisted && looksLikeMediaPath) {
      const fileExt = (url.pathname.split(".").pop() || "").toLowerCase();
      const isTwImg = isTwitterImageUrl(url);
      const isTwVid = isTwitterVideoUrl(url);

      if (isTwImg || ["png","jpg","jpeg","gif","webp"].includes(fileExt)) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.decoding = "async";
        img.src = a.href; // keep original URL with query (?format=jpg)
        img.className = "edgg-media";
        img.style.maxWidth = "500px";
        injectBelow(container, img, a.href, widthPx);
        return;
      }

      if (isTwVid || ["mp4","webm","mov"].includes(fileExt)) {
        const vid = document.createElement("video");
        vid.preload = "metadata";
        vid.controls = true; // require user interaction
        vid.playsInline = true;
        vid.className = "edgg-media";
        vid.style.maxWidth = "500px";
        vid.style.width = widthPx + "px";
        const src = document.createElement("source");
        src.src = a.href;
        // best-effort type hint
        let mime = "";
        if (isTwVid || fileExt === "mp4") mime = "video/mp4";
        else if (fileExt === "webm") mime = "video/webm";
        else mime = "video/quicktime";
        src.type = mime;
        vid.appendChild(src);
        injectBelow(container, vid, a.href, widthPx);
        return;
      }
    }

    // Optional YouTube/Twitch (lazy iframe) — toggleable
    if (isWhitelisted) {
      if (STATE.settings.enableYouTube && /(youtube\.com|youtu\.be)/.test(host)) {
        const ytId = extractYouTubeId(url);
        if (ytId) {
          const card = document.createElement("a");
          card.className = "edgg-card edgg-card-yt";
          card.href = a.href;
          card.target = "_blank";
          card.rel = "noopener noreferrer";
          card.style.maxWidth = "500px";
          card.style.width = widthPx + "px";

          /*const img = document.createElement("img");
          img.loading = "lazy";
          img.decoding = "async";
          img.alt = "Open on YouTube";
          img.src = `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`;
          img.className = "edgg-card-thumb";*/

          /*const badge = document.createElement("div");
          badge.className = "edgg-card-badge";
          badge.textContent = "YouTube ▶";*/

          const meta = document.createElement("div");
          meta.className = "edgg-card-meta";
          meta.innerHTML = `<div class="edgg-card-title">Loading…</div>`;

          //card.appendChild(img);
          //card.appendChild(badge);

          const wrap = document.createElement("div");
          wrap.className = "edgg-wrap";
          wrap.appendChild(card);
          wrap.appendChild(meta);
          // Prepare sticky state before we append
          const scroller = getScrollContainer(container);
          const linkInView = isElementInView(container, scroller);
          const shouldStick = linkInView && (STATE.stickyWanted || isAtBottom(scroller, 2));
          container.appendChild(wrap);
          maintainStickyAfterAppend(scroller, shouldStick, wrap);

          // Fetch oEmbed via background to avoid CSP and attach title/author
          chrome.runtime.sendMessage({ type: "oembed", provider: "youtube", videoUrl: a.href }, (res) => {
            if (res && res.ok && res.data) {
              const title = (res && res.data && res.data.title) ? res.data.title : "YouTube";
              const author = (res && res.data && res.data.author_name) ? ` • ${res.data.author_name}` : "";
              meta.innerHTML = `<div class="edgg-card-title">${escapeHtml(title)}<span class="edgg-card-author">${escapeHtml(author)}</span></div>`;
            } else {
              meta.innerHTML = `<div class="edgg-card-title">YouTube Video</div>`;
            }
          });
          return;
        }
      }
      if (STATE.settings.enableTwitch && /(twitch\.tv)/.test(host)) {
        const { channel, video } = extractTwitch(url);
        if (channel || video) {
          const iframe = document.createElement("iframe");
          iframe.loading = "lazy";
          iframe.allowFullscreen = true;
          iframe.className = "edgg-media";
          iframe.style.maxWidth = "500px";
          iframe.style.width = widthPx + "px";
          iframe.height = "281";
          const parent = "destiny.gg"; // required by Twitch embed
          iframe.src = channel
            ? `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${parent}`
            : `https://player.twitch.tv/?video=${encodeURIComponent(video)}&parent=${parent}`;
          injectBelow(container, iframe, a.href, widthPx);
          return;
        }
      }
    }
  }

  function renderTweetInto(cardEl, data, originUrl) {
    var body = cardEl.querySelector('.edgg-tweet-body') || cardEl;

    // Extract fields defensively
    var user = (data && data.user) ? data.user : null;
    var userName = '';
    if (user) {
      if (user.name) userName = String(user.name);
      else if (user.screen_name) userName = String(user.screen_name);
    }
    if (!userName && data && data.author_name) userName = String(data.author_name);

    var text = '';
    if (data) {
      if (data.full_text) text = String(data.full_text);
      else if (data.text) text = String(data.text);
      else if (data.description) text = String(data.description);
    }

    // Expand URLs in text if provided
    var entities = (data && data.entities) ? data.entities : null;
    if (entities && entities.urls && entities.urls.length) {
      for (var i = 0; i < entities.urls.length; i++) {
        var ent = entities.urls[i];
        var shortU = ent && ent.url ? String(ent.url) : null;
        var longU = ent && (ent.expanded_url || ent.unwound_url) ? String(ent.expanded_url || ent.unwound_url) : null;
        if (shortU && longU) {
          text = text.split(shortU).join(longU);
        }
      }
    }

    // Photos
    var photos = [];
    if (data) {
      if (data.photos && data.photos.length) photos = data.photos;
      else if (entities && entities.media && entities.media.length) photos = entities.media;
    }

    var safeUser = escapeHtml(String(userName || ''));
    var safeText = escapeHtml(String(text || ''))
      .replace(/https?:\/\/\S+/g, function(m){
        return '<a href="' + m + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(m) + '</a>';
      });

    var mediaHtml = '';
    if (photos && photos.length) {
      var imgs = [];
      for (var j = 0; j < Math.min(4, photos.length); j++) {
        var p = photos[j];
        var u = null;
        if (p) {
          if (p.url) u = String(p.url);
          else if (p.media_url_https) u = String(p.media_url_https);
          else if (p.media_url) u = String(p.media_url);
          else if (p.src) u = String(p.src);
        }
        if (u) imgs.push('<img class="edgg-media edgg-tweet-photo" loading="lazy" decoding="async" src="' + u + '">');
      }
      if (imgs.length) mediaHtml = '<div class="edgg-tweet-media">' + imgs.join('') + '</div>';
    }

    var created = '';
    if (data) {
      if (data.created_at) created = String(data.created_at);
      else if (data.date) created = String(data.date);
    }

    body.innerHTML =
      '<div class="edgg-tweet-header">' + (safeUser ? '<span class="edgg-tweet-user">' + safeUser + '</span>' : '') + '</div>' +
      '<div class="edgg-tweet-text">' + safeText + '</div>' +
      mediaHtml +
      '<div class="edgg-tweet-footer">' +
        '<a href="' + originUrl + '" target="_blank" rel="noopener noreferrer">Open on Twitter</a>' +
        (created ? ' • <span class="edgg-tweet-date">' + escapeHtml(created) + '</span>' : '') +
      '</div>';

    // If images load later, keep bottom locked
    var imgs2 = body.querySelectorAll('img');
    for (var k = 0; k < imgs2.length; k++) {
      imgs2[k].addEventListener('load', function(){
        var scroller = getScrollContainer(cardEl);
        if (isAtBottom(scroller)) scrollToBottom(scroller);
      }, { once: true });
    }

    // Apply spoiler overlays to tweet media if enabled
    if (STATE.settings.blurMedia) {
      try { applySpoilersInRoot(body); } catch (_) {}
    }
  }

  function injectBelow(container, el, originUrl, desiredWidthPx) {
    const scroller = getScrollContainer(container);
    // Only stick when the message/link is visible AND we're at-bottom/sticky
    const linkInView = isElementInView(container, scroller);
    const shouldStick = linkInView && (STATE.stickyWanted || isAtBottom(scroller, 2));

    const dataUrl = el.tagName === "IMG" || el.tagName === "IFRAME" ? el.getAttribute("src") : null;
    if (dataUrl) {
      if (container.querySelector(`[data-edgg-src="${cssEscape(dataUrl)}"]`)) return;
      el.setAttribute("data-edgg-src", dataUrl);
    }

    const wrap = document.createElement("div");
    wrap.className = "edgg-wrap edgg-right";
    if (originUrl) wrap.setAttribute("data-edgg-origin", originUrl);
    if (desiredWidthPx && Number.isFinite(desiredWidthPx)) {
      wrap.style.maxWidth = "500px";
      wrap.style.width = '100%'; //desiredWidthPx + "px";
    }

    // Ensure media fills wrapper width
    if (el && el.classList) {
      if (!el.classList.contains('edgg-media')) el.classList.add('edgg-media');
      el.style.width = '100%';
      if (el.tagName === 'IMG') el.style.height = 'auto';
    }

    // Wrap the media in a link
    let mediaEl = el;
    if (el.tagName === "IMG") {
      const elLink = document.createElement("a");
      elLink.href = originUrl;
      elLink.target = "_blank";
      elLink.rel = "noopener noreferrer";
      elLink.className = "edgg-media-link";
      elLink.appendChild(el);
      el = elLink;
      mediaEl = elLink.querySelector('img') || mediaEl;
    }

    wrap.appendChild(el);
    container.appendChild(wrap);

    // Maintain bottom lock only if we were at bottom or sticky when inserting
    maintainStickyAfterAppend(scroller, shouldStick, wrap);

    // Apply spoiler/blur overlay for media if enabled
    if (STATE.settings.blurMedia) {
      try { applySpoilerIfNeeded(wrap); } catch (_) {}
    }
  }

  function computeDesiredWidth(container) {
    // Try to infer username gutter by checking the first child element width if it looks like a username span
    let gutter = 0;
    const userEl = container.querySelector('.user, .nick, .username, [class*="name"], .from');
    if (userEl) {
      const rect = userEl.getBoundingClientRect();
      gutter = rect.width || 0;
    } else {
      // Fallback: compute left padding/margin difference
      const rect = container.getBoundingClientRect();
      gutter = Math.max(0, parseFloat(getComputedStyle(container).paddingLeft) || 0);
    }
    const containerRect = container.getBoundingClientRect();
    const width = Math.min(500, Math.max(180, containerRect.width - gutter));
    return { widthPx: Math.round(width) };
  }

  function extractYouTubeId(u) {
    // Handle youtu.be/<id>, youtube.com/watch?v=<id>, /shorts/<id>
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/shorts\/([^/]+)/);
      if (m) return m[1];
    }
    return null;
  }

  function extractTwitch(u) {
    // twitch.tv/<channel> or twitch.tv/videos/<id>
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "videos" && parts[1]) return { channel: null, video: parts[1] };
    if (parts[0]) return { channel: parts[0], video: null };
    return { channel: null, video: null };
  }

  function cssEscape(s) {
    return s.replace(/"/g, '\\"');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>\"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ---------------- Hover Preview Modal (in-page), with caching ----------------
  const EDGG_PREVIEW_CACHE = new Map(); // url -> HTMLElement (content root)
  let EDGG_PREVIEW_SHELL = null;       // singleton shell
  let EDGG_PREVIEW_TIMER = null;
  let EDGG_PREVIEW_VISIBLE = false;

  function ensurePreviewShell() {
    if (EDGG_PREVIEW_SHELL) return EDGG_PREVIEW_SHELL;
    const shell = document.createElement('div');
    shell.id = 'edgg-hover-preview';
    shell.setAttribute('aria-hidden', 'true');
    shell.innerHTML = `
      <div class="edgg-hover-inner">
        <div class="edgg-hover-content"></div>
      </div>
    `;
    document.documentElement.appendChild(shell);

    // Keep open while hovering the shell
    shell.addEventListener('mouseenter', () => { clearTimeout(EDGG_PREVIEW_TIMER); });
    shell.addEventListener('mouseleave', () => { scheduleHidePreview(); });

    EDGG_PREVIEW_SHELL = shell;
    return shell;
  }

  function scheduleHidePreview(delay = 200) {
    clearTimeout(EDGG_PREVIEW_TIMER);
    EDGG_PREVIEW_TIMER = setTimeout(() => {
      const shell = ensurePreviewShell();
      shell.style.display = 'none';
      shell.setAttribute('aria-hidden', 'true');
      EDGG_PREVIEW_VISIBLE = false;
      // cache persists for session
    }, delay);
  }

  function positionPreview(x, y, maxW = 720, maxH = 480) {
    const shell = ensurePreviewShell();
    const pad = 12;
    const w = Math.min(maxW, Math.max(280, Math.floor(window.innerWidth * 0.5)));
    const h = Math.min(maxH, Math.max(200, Math.floor(window.innerHeight * 0.5)));
    const left = Math.min(Math.max(0, x + 16), window.innerWidth - w - pad);
    const top  = Math.min(Math.max(0, y + 16), window.innerHeight - h - pad);
    shell.style.width = w + 'px';
    shell.style.height = h + 'px';
    shell.style.left = left + 'px';
    shell.style.top = top + 'px';
  }

  // ---- Auto-scroll helpers ----
  function isElementInView(el, scroller, threshold = 1) {
    try {
      if (!el || !scroller) return false;
      const er = el.getBoundingClientRect();
      const isDoc = (scroller === document.scrollingElement) || (scroller === document.documentElement) || (scroller === document.body);
      const sr = isDoc ? { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth } : scroller.getBoundingClientRect();
      return (er.bottom > sr.top + threshold) && (er.top < sr.bottom - threshold);
    } catch (_) { return false; }
  }

  // ---- Spoiler overlay helpers ----
  function applySpoilerIfNeeded(wrap) {
    if (!wrap || !(wrap instanceof HTMLElement)) return;
    // Only blur direct image/video content; leave iframes alone here
    const media = wrap.querySelector('img, video');
    if (!media) return;
    if (!STATE.settings.blurMedia) return;
    if (wrap.classList.contains('edgg-spoiler-revealed')) return;
    if (wrap.querySelector('.edgg-spoiler-cover')) return;

    wrap.classList.add('edgg-spoiler');

    // Blur the media element
    media.classList.add('edgg-spoiler-blur');

    // Overlay cover
    const cover = document.createElement('div');
    cover.className = 'edgg-spoiler-cover';
    cover.setAttribute('role', 'button');
    cover.setAttribute('tabindex', '0');
    cover.setAttribute('aria-label', 'Reveal media');
    const txt = document.createElement('div');
    txt.className = 'edgg-spoiler-text';
    txt.textContent = 'Spoiler — click to reveal';
    cover.appendChild(txt);
    wrap.appendChild(cover);

    const reveal = () => {
      media.classList.remove('edgg-spoiler-blur');
      wrap.classList.remove('edgg-spoiler');
      wrap.classList.add('edgg-spoiler-revealed');
      if (cover && cover.parentNode) cover.parentNode.removeChild(cover);
    };

    cover.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); reveal(); }, true);
    cover.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); reveal(); }
    }, true);
  }

  function applySpoilersInRoot(root) {
    if (!STATE.settings.blurMedia) return;
    if (!root || !root.querySelectorAll) return;
    const nodes = root.querySelectorAll('img.edgg-media, video.edgg-media');
    nodes.forEach((m) => {
      if (!(m instanceof HTMLElement)) return;
      // If already within an edgg-spoiler wrapper, skip
      if (m.closest('.edgg-spoiler-revealed') || m.closest('.edgg-spoiler-cover')) return;
      let parent = m.parentElement;
      if (!parent) return;

      // If the immediate parent is a single-media container (like our wrap), use overlay approach
      if (parent.classList && parent.classList.contains('edgg-wrap')) {
        applySpoilerIfNeeded(parent);
        return;
      }

      // Otherwise, create a per-media spoiler wrapper
      const holder = document.createElement('div');
      holder.className = 'edgg-spoiler';
      holder.style.position = 'relative';
      parent.insertBefore(holder, m);
      holder.appendChild(m);
      m.classList.add('edgg-spoiler-blur');

      const cover = document.createElement('div');
      cover.className = 'edgg-spoiler-cover';
      cover.setAttribute('role', 'button');
      cover.setAttribute('tabindex', '0');
      cover.setAttribute('aria-label', 'Reveal media');
      const txt = document.createElement('div');
      txt.className = 'edgg-spoiler-text';
      txt.textContent = 'Spoiler — click to reveal';
      cover.appendChild(txt);
      holder.appendChild(cover);

      const reveal = () => {
        m.classList.remove('edgg-spoiler-blur');
        holder.classList.add('edgg-spoiler-revealed');
        if (cover && cover.parentNode) cover.parentNode.removeChild(cover);
      };
      cover.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); reveal(); }, true);
      cover.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); reveal(); }
      }, true);
    });
  }
  function maintainStickyAfterAppend(scroller, shouldStick, rootEl) {
    if (!shouldStick) return;

    const doScroll = () => {
      if (STATE.stickyWanted || isAtBottom(scroller, 2)) scrollToBottom(scroller);
    };

    // Immediate and staged corrections
    doScroll();
    requestAnimationFrame(doScroll);
    setTimeout(doScroll, 50);
    setTimeout(doScroll, 150);
    setTimeout(doScroll, 300);
    setTimeout(() => { if (STATE.stickyWanted) doScroll(); }, 800);

    // React to late-loading media
    try {
      const media = rootEl.querySelectorAll('img,video,iframe');
      media.forEach((m) => {
        const ev = m.tagName === 'VIDEO' ? 'loadedmetadata' : 'load';
        m.addEventListener(ev, doScroll, { once: true });
      });
    } catch (_) {}

    // React to size changes of the embed wrapper
    try {
      const ro = new ResizeObserver(() => { if (STATE.stickyWanted) doScroll(); });
      ro.observe(rootEl);
      // Stop observing after a short stabilization window
      setTimeout(() => { try { ro.disconnect(); } catch (_) {} }, 2000);
    } catch (_) {}
  }
  function getScrollContainer(startEl) {
    // Find the nearest scrollable ancestor; fallback to document.scrollingElement
    let el = startEl && startEl.parentElement;
    while (el) {
      const style = getComputedStyle(el);
      const canScroll = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20;
      if (canScroll) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.body;
  }

  function isAtBottom(scroller, threshold = 32) {
    return (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) <= threshold;
  }

  function scrollToBottom(scroller) {
    scroller.scrollTop = scroller.scrollHeight;
  }

  async function showPreviewFor(originUrl, x, y) {
    const shell = ensurePreviewShell();
    const contentRoot = shell.querySelector('.edgg-hover-content');

    positionPreview(x, y);

    // Reuse cached DOM if available
    let node = EDGG_PREVIEW_CACHE.get(originUrl);
    if (node && node.isConnected) {
      node = node.cloneNode(true); // reuse without moving the cached node
    }
    if (!node) {
      node = await buildPreviewContent(originUrl, shell.clientWidth);
      EDGG_PREVIEW_CACHE.set(originUrl, node.cloneNode(true)); // cache clone
    }

    contentRoot.innerHTML = '';
    contentRoot.appendChild(node);

    shell.style.display = 'block';
    shell.setAttribute('aria-hidden', 'false');
    EDGG_PREVIEW_VISIBLE = true;
  }

  async function buildPreviewContent(originUrl, _maxWidth) {
    let el;
    try {
      const u = new URL(originUrl, location.href);
      const host = u.hostname;
      const looksMedia = MEDIA_EXT.test(u.pathname);

      // 1) Whitelisted direct media -> show actual content
      if (MEDIA_WHITELIST.has(host) && looksMedia) {
        const ext = (u.pathname.split('.').pop() || '').toLowerCase();
        if (["png","jpg","jpeg","gif","webp"].includes(ext)) {
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.decoding = 'async';
          img.src = originUrl;
          img.className = 'edgg-hover-media';
          el = img;
        } else if (["mp4","webm","mov"].includes(ext)) {
          const vid = document.createElement('video');
          vid.controls = true;
          vid.preload = 'metadata';
          vid.playsInline = true;
          vid.className = 'edgg-hover-media';
          const source = document.createElement('source');
          source.src = originUrl;
          source.type = ext === 'mp4' ? 'video/mp4' : (ext === 'webm' ? 'video/webm' : 'video/quicktime');
          vid.appendChild(source);
          el = vid;
        }
        if (el) return wrapPreview(el);
      }

      // 2) YouTube -> CSP blocks iframes: show thumbnail + title via oEmbed
      if (/(youtube\.com|youtu\.be)/.test(host)) {
        const ytId = extractYouTubeId(u);
        const card = document.createElement('div');
        card.className = 'edgg-card edgg-card-yt';
        card.style.maxWidth = '100%';
        const img = document.createElement('img');
        img.className = 'edgg-card-thumb';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : '';
        const badge = document.createElement('div');
        badge.className = 'edgg-card-badge';
        badge.textContent = 'YouTube ▶';
        const meta = document.createElement('div');
        meta.className = 'edgg-card-meta';
        meta.innerHTML = `<div class="edgg-card-title">Loading…</div>`;
        card.appendChild(img);
        card.appendChild(badge);
        const wrap = document.createElement('div');
        wrap.appendChild(card);
        wrap.appendChild(meta);
        chrome.runtime.sendMessage({ type: 'oembed', provider: 'youtube', videoUrl: originUrl }, (res) => {
          if (res && res.ok && res.data) {
            const title = res.data.title || 'YouTube';
            const author = res.data.author_name ? ` • ${res.data.author_name}` : '';
            meta.innerHTML = `<div class="edgg-card-title">${escapeHtml(title)}<span class="edgg-card-author">${escapeHtml(author)}</span></div>`;
          } else {
            meta.innerHTML = `<div class="edgg-card-title">YouTube Video</div>`;
          }
        });
        return wrapPreview(wrap);
      }

      // 3) Twitch -> CSP allows twitch player; use iframe
      if (/(^|\.)twitch\.tv$/i.test(host)) {
        const { channel, video } = extractTwitch(u);
        if (channel || video) {
          const iframe = document.createElement('iframe');
          iframe.loading = 'lazy';
          iframe.allowFullscreen = true;
          iframe.className = 'edgg-hover-media';
          const parent = 'destiny.gg';
          iframe.src = channel
            ? `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${parent}`
            : `https://player.twitch.tv/?video=${encodeURIComponent(video)}&parent=${parent}`;
          return wrapPreview(iframe);
        }
      }

      // 4) Vimeo -> CSP allows *.vimeo.com frames
      if (/(^|\.)vimeo\.com$/i.test(host)) {
        const m = u.pathname.match(/\/(?:video\/)?(\d+)/);
        const vidId = m ? m[1] : null;
        if (vidId) {
          const iframe = document.createElement('iframe');
          iframe.loading = 'lazy';
          iframe.allowFullscreen = true;
          iframe.className = 'edgg-hover-media';
          iframe.src = `https://player.vimeo.com/video/${vidId}`;
          return wrapPreview(iframe);
        }
      }

      // 5) Fallback safe link card
      const a = document.createElement('a');
      a.href = originUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'edgg-card';
      a.textContent = originUrl;
      return wrapPreview(a);

    } catch (e) {
      const pre = document.createElement('pre');
      pre.textContent = String(e);
      return wrapPreview(pre);
    }
  }

  function wrapPreview(inner) {
    const container = document.createElement('div');
    container.className = 'edgg-hover-body';
    container.appendChild(inner);
    return container;
  }

  // Hover delegation for links and embeds using mouseover/mouseout (mouseenter doesn't bubble)
  let EDGG_LAST_HOVER_URL = null;

  document.addEventListener('mouseover', (ev) => {
    if (!STATE.settings.enableHoverPreview) return;
    const t = ev.target;
    if (!t || !(t instanceof HTMLElement)) return;

    // Ignore transitions within the same element tree
    const rel = ev.relatedTarget;
    if (rel && t.contains && t.contains(rel)) return;

    let url = null;
    const wrap = t.closest('.edgg-wrap');
    if (wrap && wrap.getAttribute('data-edgg-origin')) url = wrap.getAttribute('data-edgg-origin');
    if (!url) {
      const a = t.closest('a[href]');
      if (a) url = a.href;
    }
    if (!url) return;

    if (EDGG_LAST_HOVER_URL === url && EDGG_PREVIEW_VISIBLE) {
      // Reposition only for smoother UX
      positionPreview(ev.clientX, ev.clientY);
      return;
    }

    EDGG_LAST_HOVER_URL = url;
    clearTimeout(EDGG_PREVIEW_TIMER);
    const x = ev.clientX, y = ev.clientY;
    const delay = STATE.settings.renderOnHover ? 100 : 200;
    EDGG_PREVIEW_TIMER = setTimeout(() => showPreviewFor(url, x, y), delay);
  }, true);

  document.addEventListener('mouseout', (ev) => {
    if (!STATE.settings.enableHoverPreview) return;
    const t = ev.target;
    if (!t || !(t instanceof HTMLElement)) return;

    const toEl = ev.relatedTarget;
    // If moving into the preview shell, don't hide
    const shell = EDGG_PREVIEW_SHELL || document.getElementById('edgg-hover-preview');
    if (shell && toEl && shell.contains(toEl)) return;
    // If staying within the same element subtree, ignore
    if (toEl && t.contains && t.contains(toEl)) return;

    scheduleHidePreview();
  }, true);

  // Bonus: click to force preview open at cursor, even on non-anchors
  document.addEventListener("click", (ev) => {
    if (!STATE.settings.enableHoverPreview) return;
    const t = ev.target;
    if (!t || !(t instanceof HTMLElement)) return;

    let url = null;
    const wrap = t.closest(".edgg-wrap");
    if (wrap && wrap.getAttribute("data-edgg-origin")) {
      url = wrap.getAttribute("data-edgg-origin");
    }
    if (!url) {
      const aEl = t.closest("a[href]");
      if (aEl) url = aEl.href;
    }
    if (!url) return;

    // If the user clicked a non-anchor element, open our modal at the click position
    if (!t.closest("a[href]")) {
      ev.preventDefault();
      const x = (typeof ev.clientX === "number") ? ev.clientX : Math.floor(window.innerWidth / 2);
      const y = (typeof ev.clientY === "number") ? ev.clientY : Math.floor(window.innerHeight / 2);
      showPreviewFor(url, x, y);
    }
  }, true);

})();
