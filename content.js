/**
 * @file content.js
 * 
 * Content script for embeDGG Chrome extension. 
 * Embeds tweets, images, videos, YouTube, Twitch in destiny.gg chat.
 */
(() => {
  const STATE = {
    settings: {
      enableTweets: true,
      enableMedia: true,
      enableYouTube: true,
      enableTwitch: true,
      enableKick: true,
      enableInstagram: true,
      blurMedia: false,
    }
  };
  // Maintains a temporary stick-to-bottom intent after user clicks DGG's "More messages below"
  STATE.stickyWanted = false; // when true, embeds will force-scroll to bottom even if height grows
  
  // Auto-scroll fix: Prevents scroll handler from updating stickyWanted during embed insertion.
  // When embeds are added to the DOM, they can cause temporary scroll position changes that
  // would incorrectly disable auto-scroll even when the user was at the bottom.
  STATE.insertingEmbed = false;

  const MEDIA_EXT = /\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i;
  const MEDIA_WHITELIST = new Set([
    "cdn.syndication.twimg.com","destiny.gg/embed/chat*","twitter.com","mobile.twitter.com","pic.twitter.com",
    "x.com","t.co","nitter.net","fxtwitter.com","vxtwitter.com","imgur.com","i.imgur.com","flickr.com",
    "youtube.com","youtu.be","vimeo.com","giphy.com","media.giphy.com","tenor.com",
    "media.tenor.com","streamable.com","dropbox.com","*.dropboxusercontent.com",
    "onedrive.live.com","photos.google.com","lh3.googleusercontent.com","icloud.com",
    "res.cloudinary.com","s3.amazonaws.com","cdn.discordapp.com","i.4cdn.org","kick.com",
    "twitch.tv","www.twitch.tv","files.catbox.moe","destiny.gg/bigscreen*","packaged-media.redd.it","reddit.com",
    "i.redd.it","preview.redd.it","v.redd.it","cdn.syndication.twimg.com","publish.twitter.com",
    "pbs.twimg.com","video.twimg.com","i.kym-cdn.com"
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

  // ---- Cross-browser compatibility and messaging safety helpers ----
  // Cross-browser compatibility: Firefox uses 'browser' namespace, Chrome uses 'chrome'
  const api = typeof browser !== 'undefined' ? browser : chrome;
  
  function isExtAlive() {
    try { return typeof api !== 'undefined' && !!(api.runtime && api.runtime.id); } catch (_) { return false; }
  }
  function safeSendMessage(msg, cb) {
    if (!isExtAlive()) { try { cb && cb(null); } catch (_) {} return; }
    try {
      api.runtime.sendMessage(msg, (res) => {
        // Swallow runtime errors like "Extension context invalidated"
        if (api && api.runtime && api.runtime.lastError) { try { cb && cb(null); } catch (_) {} return; }
        try { cb && cb(res); } catch (_) {}
      });
    } catch (_) { try { cb && cb(null); } catch (_) {} }
  }

  // Fetch settings from background (safe)
  safeSendMessage({ type: "getSettings" }, (res) => {
    if (res && res.ok) STATE.settings = { ...STATE.settings, ...res.settings };
    init();
  });

  // Update-on-change (apply for new messages only)
  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "settingsUpdated") {
      safeSendMessage({ type: "getSettings" }, (res) => {
        if (res && res.ok) STATE.settings = { ...STATE.settings, ...res.settings };
      });
    }
  });

  /**
   * Mint a new NFT on the Blockchain via the command line.
   * 
   * @returns {void}
   */
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
        if (el.classList && el.classList.contains('edgg-wrap')) continue;
        if (el.closest && el.closest('.edgg-wrap')) continue;
        // Realtime embed for newly added messages
        maybeEmbedInNode(el);
      }
    }
    // Setup sticky bottom hook for DGG "More messages below"
    setupDggMoreBelowHook();
  }

  /**
   * Find the primary scrollable container for the chat window.
   * Falls back to document.scrollingElement when no explicit container exists.
   */
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

  /**
   * Hook DGG's ephemeral "More messages below" UI to preserve stick‑to‑bottom
   * intent when new embeds load and change layout. We set a short sticky window
   * so async image/video loads still keep the chat pinned to the bottom.
   */
  function setupDggMoreBelowHook() {
    const scroller = findScrollableRoot();

    // Keep STATE.stickyWanted in sync with user scroll position
    const onScroll = () => {
      try { 
        // Auto-scroll fix: Skip updating stickyWanted during embed insertion to prevent
        // temporary scroll position changes from disabling auto-scroll
        if (!STATE.insertingEmbed) {
          STATE.stickyWanted = isAtBottom(scroller); 
        }
      } catch (_) {}
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

  /**
   * Scan a newly added (or just‑scrolled‑into‑view) message element and try
   * embedding any supported links inside it.
   */
  function maybeEmbedInNode(el) {
    // Ignore our injected UI
    if (!el || (el.classList && el.classList.contains('edgg-wrap'))) return;
    if (el.closest && el.closest('.edgg-wrap')) return;
    // Expect messages to contain anchor tags. If none, skip.
    const anchors = el.querySelectorAll ? el.querySelectorAll("a[href]") : [];
    if (!anchors.length) return;

    anchors.forEach(a => {
      tryEmbed(a, el);
    });
  }

  /** Return true if a hostname belongs to a supported Twitter/X front‑end. */
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

  /**
   * Core embed router. Given an anchor and its message container, decide what
   * to render (tweet card, direct image/video, YouTube/Twitch card, etc.).
   */
  function tryEmbed(a, container) {
    const url = new URL(a.href, location.href);
    const host = url.hostname;
    const sensitivity = getSensitivityLabel(container);
    const linkText = (a.textContent || '').trim();

    // If this anchor is a plain "(source)" link, skip embedding for it
    if (linkText === '(source)') return;

    // Respect DGG chat settings for hiding NSFL/NSFW
    try {
      if (sensitivity === 'NSFL' && isHideNsflEnabled()) return;
      if (sensitivity === 'NSFW' && isHideNsfwEnabled() && getShowRemovedSetting() === '0') return;
    } catch (_) {}

    // Require login heuristic: if chat shows "Log in" prominently, bail. (MVP heuristic)
    const pageText = (document.body && document.body.innerText ? document.body.innerText.toLowerCase() : "");
    if (pageText.includes("log in") && !pageText.includes("logout")) {
      return;
    }

    const isTweet = isTweetUrlHost(host) && (/\/status\/\d+/.test(url.pathname) || /\/i\/web\/status\/\d+/.test(url.pathname));
    const isPicShort = /^pic\.twitter\.com$/i.test(host.replace(/^www\./, ''));
    const looksLikeMediaPath = MEDIA_EXT.test(url.pathname) || isTwitterImageUrl(url) || isTwitterVideoUrl(url);
    const isWhitelisted = MEDIA_WHITELIST.has(host) || isTwitterImageUrl(url) || isTwitterVideoUrl(url);

    // Resolve Twitter shortlinks (t.co) to their final destination, then re-run embed logic once
    if (/^t\.co$/i.test(host) && !a.__edggResolvedTco) {
      a.__edggResolvedTco = true;
      safeSendMessage({ type: 'bgFetch', url: a.href }, (res) => {
        try {
          const finalUrl = res && res.finalUrl ? res.finalUrl : null;
          if (!finalUrl || finalUrl === a.href) return;
          const a2 = document.createElement('a');
          a2.href = finalUrl;
          a2.textContent = a.textContent || '';
          tryEmbed(a2, container);
        } catch (_) {}
      });
      return;
    }

    // Compute embed width: chat container width minus username gutter; cap at 566px
    const { widthPx } = computeDesiredWidth(container);

    // Special-case: DGG bigscreen Twitch hash links (e.g., #twitch/xqc)
    if (STATE.settings.enableTwitch) {
      const chan = extractDggBigscreenTwitch(url, linkText);
      if (chan) {
        // Build a lightweight Twitch card (thumbnail + title)
        const card = document.createElement('a');
        card.className = 'edgg-card edgg-card-tw';
        card.href = a.href;
        card.target = '_blank';
        card.rel = 'noopener noreferrer';
        card.style.maxWidth = '566px';
        card.style.width = widthPx + 'px';

        const thumb = document.createElement('img');
        thumb.className = 'edgg-card-thumb';
        thumb.alt = 'Open on Twitch';
        thumb.style.display = 'block';
        thumb.style.width = '100%';
        card.appendChild(thumb);

        const overlay = document.createElement('div');
        overlay.className = 'edgg-card-overlay';
        overlay.innerHTML = '<div class="edgg-card-title-bg"></div><div class="edgg-card-title">Loading…</div>';
        card.appendChild(overlay);

        const wrap = document.createElement('div');
        wrap.className = 'edgg-wrap';
        wrap.appendChild(card);

        const scroller = getScrollContainer(container);
        const linkInView = isElementInView(container, scroller);
        const shouldStick = linkInView && (STATE.stickyWanted || isAtBottom(scroller, 2));
        // Auto-scroll fix: Use safeAppendEmbed instead of direct appendChild to preserve sticky state
        safeAppendEmbed(container, wrap, scroller, shouldStick);
        try { retargetLinks(wrap); } catch (_) {}

        // Fetch page metadata from Twitch channel URL for thumbnail + title
        const channelUrl = `https://www.twitch.tv/${encodeURIComponent(chan)}`;
        safeSendMessage({ type: 'bgFetch', url: channelUrl }, (res) => {
          try {
            let title = `Twitch • ${chan}`;
            let image = '';
            let wasLive = false;
            if (res && res.ok && res.body) {
              const doc = new DOMParser().parseFromString(res.body, 'text/html');
              const pick = (sel) => { const n = doc.querySelector(sel); return n ? (n.getAttribute('content') || '').trim() : ''; };
              image = pick('meta[property="og:image"]') || pick('meta[name="twitter:image"]');
              const desc = pick('meta[property="og:description"]') || pick('meta[name="twitter:description"]');
              // Try to extract live stream title from the raw HTML first
              const liveTitle = extractTwitchLiveTitle(res.body);
              if (liveTitle) {
                title = liveTitle;
                image = getTwitchLivePreviewUrl(chan, 640, 360) || image;
                wasLive = true;
              } else {
                // Prefer page description (often the live title) before og:title
                title = (desc && desc.length >= 3 ? desc : (pick('meta[property="og:title"]') || pick('meta[name="twitter:title"]') || title));
              }
            }
            if (image) thumb.src = image; else { thumb.remove(); }
            const tnode = overlay.querySelector('.edgg-card-title');
            if (tnode) tnode.textContent = title;
            if (wasLive) {
              try { startTwitchThumbAutoRefresh(thumb, chan, 60000, wrap); } catch (_) {}
            }
          } catch (_) { const tnode = overlay.querySelector('.edgg-card-title'); if (tnode) tnode.textContent = `Twitch • ${chan}`; try { thumb.remove(); } catch (_) {} }
        });
        return;
      }
    }

    if (STATE.settings.enableTweets && isWhitelisted && (isTweet || isPicShort)) {
      const card = document.createElement('div');
      card.className = 'edgg-embed edgg-tweet';
      card.style.maxWidth = '566px';
      card.style.width = widthPx + 'px';
      card.innerHTML = `<div class="edgg-tweet-body"><div class="edgg-tweet-line">Loading tweet…</div></div>`;
      injectBelow(container, card, a.href, widthPx, sensitivity);

      safeSendMessage({ type: 'fetchTweet', url: a.href }, (res) => {
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
            var candidateTweetUrl = null;
            if (bq) {
              var anchors = bq.querySelectorAll('a');
              for (var i = 0; i < anchors.length; i++) {
                var aTag = anchors[i];
                var hrefVal = aTag.getAttribute('href') || '';
                // Always drop pic.twitter.com shortlinks from text
                try {
                  var hrefU = new URL(hrefVal, location.href);
                  var hrefHost = hrefU.hostname.toLowerCase().replace(/^www\./, '');
                  if (hrefHost === 'pic.twitter.com') {
                    var anchorHtml = aTag.outerHTML;
                    if (textHtml) textHtml = textHtml.replace(anchorHtml, '');
                  }
                } catch (_) {}

                var expanded = aTag.getAttribute('data-expanded-url') || hrefVal || '';
                try {
                  var eu = new URL(expanded, location.href);
                  var h = eu.hostname.toLowerCase().replace(/^www\./, '');
                  var path = eu.pathname.toLowerCase();
                  // Track a candidate tweet URL for a second-pass JSON render if media not directly present
                  if (!candidateTweetUrl && (h === 'twitter.com' || h === 'x.com' || h === 'mobile.twitter.com') && (/\/status\/\d+/.test(path) || /\/i\/web\/status\/\d+/.test(path))) {
                    candidateTweetUrl = eu.href;
                  }
                  // Inline images from pbs.twimg.com (Twitter media CDN)
                  if (h === 'pbs.twimg.com' && /\.(jpg|jpeg|png|webp|gif)(?:$|\?)/.test(path)) {
                    var img = document.createElement('img');
                    img.className = 'edgg-media edgg-tweet-photo';
                    img.loading = 'lazy';
                    img.decoding = 'async';
                    img.src = eu.href;
                    mediaNodes.push(img);
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

      // Ensure all links open in a new tab and expand t.co shortlinks inside text
      try { retargetLinks(bodyEl); } catch (_) {}
      try { expandTcoLinksIn(bodyEl); } catch (_) {}

          // If oEmbed didn't expose direct pbs/video URLs, try a second pass via CDN JSON using a candidate tweet URL
          if (!mediaNodes.length && candidateTweetUrl) {
            safeSendMessage({ type: 'fetchTweet', url: candidateTweetUrl }, (res2) => {
              try {
                if (res2 && res2.ok && res2.data) {
                  renderTweetInto(card, res2.data, a.href);
                }
              } catch (_) {}
            });
          }

          // Keep bottom lock if images/videos load later
          var scrollerX = getScrollContainer(card);
          var imgsX = bodyEl.querySelectorAll('img,video');
          for (var xi = 0; xi < imgsX.length; xi++) {
            var elX = imgsX[xi];
            var evName = elX.tagName === 'VIDEO' ? 'loadedmetadata' : 'load';
            elX.addEventListener(evName, function(){ if (isAtBottom(scrollerX)) scrollToBottom(scrollerX); }, { once: true });
          }

          // Ensure CSP-safe videos (convert to blob: if needed)
          try { ensureCspSafeVideos(bodyEl); } catch (_) {}

          // Apply spoiler overlays if blur enabled or sensitivity flagged
          try { applySpoilersInRoot(bodyEl, sensitivity, STATE.settings.blurMedia || !!sensitivity); } catch (_) {}
          
          // Initialize pager if multiple media present (after spoiler setup)
          try { initTweetMediaPager(bodyEl); } catch (_) {}
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
        img.style.maxWidth = "566px";
        injectBelow(container, img, a.href, widthPx, sensitivity);
        return;
      }

      if (isTwVid || ["mp4","webm","mov"].includes(fileExt)) {
        const vid = document.createElement("video");
        vid.preload = "metadata";
        vid.controls = true; // require user interaction
        vid.playsInline = true;
        vid.className = "edgg-media";
        vid.style.maxWidth = "566px";
        vid.style.width = widthPx + "px";
        const blocked = isCspBlockedHost(url.hostname);
        if (!blocked) {
          const src = document.createElement("source");
          src.src = a.href;
          // best-effort type hint
          let mime = "";
          if (isTwVid || fileExt === "mp4") mime = "video/mp4";
          else if (fileExt === "webm") mime = "video/webm";
          else mime = "video/quicktime";
          src.type = mime;
          vid.appendChild(src);
        }
        try { prepareVideoForCsp(vid, a.href); } catch (_) {}
        injectBelow(container, vid, a.href, widthPx, sensitivity);
        return;
      }
    }

    // Reddit redirector: https://www.reddit.com/media?url=<encoded direct media>
    if (STATE.settings.enableMedia && /(^|\.)reddit\.com$/i.test(host) && url.pathname === '/media') {
      const target = url.searchParams.get('url');
      if (target) {
        try {
          const mu = new URL(target, location.href);
          const mhost = mu.hostname.replace(/^www\./, '');
          const mExt = (mu.pathname.split('.').pop() || '').toLowerCase();
          const okHost = MEDIA_WHITELIST.has(mhost) || /(^|\.)redd\.it$/i.test(mhost);
          if (okHost) {
            if (["png","jpg","jpeg","gif","webp"].includes(mExt)) {
              const img = document.createElement('img');
              img.loading = 'lazy';
              img.decoding = 'async';
              img.src = mu.href;
              img.className = 'edgg-media';
              img.style.maxWidth = '566px';
              injectBelow(container, img, a.href, widthPx, sensitivity);
              return;
            }
            if (["mp4","webm","mov"].includes(mExt)) {
              const vid = document.createElement('video');
              vid.preload = 'metadata';
              vid.controls = true;
              vid.playsInline = true;
              vid.className = 'edgg-media';
              vid.style.maxWidth = '566px';
              vid.style.width = widthPx + 'px';
              const src = document.createElement('source');
              src.src = mu.href;
              src.type = mExt === 'mp4' ? 'video/mp4' : (mExt === 'webm' ? 'video/webm' : 'video/quicktime');
              vid.appendChild(src);
              try { prepareVideoForCsp(vid, mu.href); } catch (_) {}
              injectBelow(container, vid, a.href, widthPx, sensitivity);
              return;
            }
          }
        } catch (_) {}
      }
    }

    // Imgur page without direct file extension: fetch and resolve OG media
    if (STATE.settings.enableMedia && /(^|\.)imgur\.com$/i.test(host) && !looksLikeMediaPath) {
      resolveAndEmbedImgur(a.href, container, widthPx, sensitivity);
      return;
    }

    // Instagram page: thumbnail + caption overlay (links to original page)
    if (STATE.settings.enableInstagram && /(^|\.)instagram\.com$/i.test(host)) {
      resolveAndEmbedInstagram(a.href, container, widthPx, sensitivity);
      return;
    }

    // Reddit post (embed text + media)
    if (STATE.settings.enableMedia && /(^|\.)reddit\.com$/i.test(host) && /\/comments\//.test(url.pathname)) {
      resolveAndEmbedReddit(a.href, container, widthPx, sensitivity);
      return;
    }

    // Optional YouTube/Twitch (lazy iframe) — toggleable
    if (isWhitelisted) {
      if (STATE.settings.enableYouTube && /(youtube\.com|youtu\.be)/.test(host)) {
        const ytId = extractYouTubeId(url);
        if (ytId) {
          const card = document.createElement('a');
          card.className = 'edgg-card edgg-card-yt';
          card.href = a.href;
          card.target = '_blank';
          card.rel = 'noopener noreferrer';
          card.style.maxWidth = '566px';
          card.style.width = widthPx + 'px';

          const thumb = document.createElement('img');
          thumb.className = 'edgg-card-thumb';
          thumb.alt = 'Open on YouTube';
          thumb.style.display = 'block';
          thumb.style.width = '100%';
          thumb.src = `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`;
          card.appendChild(thumb);

          const overlay = document.createElement('div');
          overlay.className = 'edgg-card-overlay';
          overlay.innerHTML = '<div class="edgg-card-title-bg"></div><div class="edgg-card-title">Loading…</div>';
          card.appendChild(overlay);

          const wrap = document.createElement('div');
          wrap.className = 'edgg-wrap';
          wrap.appendChild(card);
          const scroller = getScrollContainer(container);
          const linkInView = isElementInView(container, scroller);
          const shouldStick = linkInView && (STATE.stickyWanted || isAtBottom(scroller, 2));
          // Auto-scroll fix: Use safeAppendEmbed instead of direct appendChild to preserve sticky state
          safeAppendEmbed(container, wrap, scroller, shouldStick);
          try { retargetLinks(wrap); } catch (_) {}

          // Fetch oEmbed via background to avoid CSP and attach title/thumbnail
          safeSendMessage({ type: 'oembed', provider: 'youtube', videoUrl: a.href }, (res) => {
            try {
              const tn = overlay.querySelector('.edgg-card-title');
              if (res && res.ok && res.data) {
                if (tn) tn.textContent = res.data.title || 'YouTube';
                if (res.data.thumbnail_url) thumb.src = res.data.thumbnail_url;
              } else {
                if (tn) tn.textContent = 'YouTube Video';
              }
            } catch (_) {}
          });

          // Probe watch page for live status; if live, prefer live thumb and auto-refresh
          safeSendMessage({ type: 'bgFetch', url: a.href }, (res2) => {
            try {
              if (res2 && res2.ok && res2.body) {
                const live = isYouTubeLive(res2.body);
                let base = thumb.src;
                if (live && ytId) {
                  base = `https://i.ytimg.com/vi/${ytId}/hqdefault_live.jpg`;
                  thumb.src = base;
                }
                startThumbAutoRefresh(thumb, base, 60000, wrap);
              }
            } catch (_) {}
          });
          return;
        }
      }
      if (STATE.settings.enableTwitch && /(twitch\.tv)/.test(host)) {
        const { channel, video } = extractTwitch(url);
        if (channel || video) {
          // Build a lightweight Twitch card for channels or VODs
          const card = document.createElement('a');
          card.className = 'edgg-card edgg-card-tw';
          card.href = a.href;
          card.target = '_blank';
          card.rel = 'noopener noreferrer';
          card.style.maxWidth = '566px';
          card.style.width = widthPx + 'px';

          const thumb = document.createElement('img');
          thumb.className = 'edgg-card-thumb';
          thumb.alt = 'Open on Twitch';
          thumb.style.display = 'block';
          thumb.style.width = '100%';
          card.appendChild(thumb);

          const overlay = document.createElement('div');
          overlay.className = 'edgg-card-overlay';
          overlay.innerHTML = '<div class="edgg-card-title-bg"></div><div class="edgg-card-title">Loading…</div>';
          card.appendChild(overlay);

          const wrap = document.createElement('div');
          wrap.className = 'edgg-wrap';
          wrap.appendChild(card);
          const scroller = getScrollContainer(container);
          const linkInView = isElementInView(container, scroller);
          const shouldStick = linkInView && (STATE.stickyWanted || isAtBottom(scroller, 2));
          // Auto-scroll fix: Use safeAppendEmbed instead of direct appendChild to preserve sticky state
          safeAppendEmbed(container, wrap, scroller, shouldStick);
          try { retargetLinks(wrap); } catch (_) {}

          // Choose a URL to fetch for metadata
          const fetchUrl = channel ? `https://www.twitch.tv/${encodeURIComponent(channel)}`
                                   : `https://www.twitch.tv/videos/${encodeURIComponent(video)}`;
          safeSendMessage({ type: 'bgFetch', url: fetchUrl }, (res) => {
            try {
              let title = channel ? `Twitch • ${channel}` : `Twitch Video • ${video}`;
              let image = '';
              let wasLive = false;
              if (res && res.ok && res.body) {
                const doc = new DOMParser().parseFromString(res.body, 'text/html');
                const pick = (sel) => { const n = doc.querySelector(sel); return n ? (n.getAttribute('content') || '').trim() : ''; };
                image = pick('meta[property="og:image"]') || pick('meta[name="twitter:image"]');
                const desc = pick('meta[property="og:description"]') || pick('meta[name="twitter:description"]');
                // For channel pages, prefer live title if available
                const liveTitle = channel ? extractTwitchLiveTitle(res.body) : null;
                if (liveTitle) {
                  title = liveTitle;
                  image = getTwitchLivePreviewUrl(channel, 640, 360) || image;
                  wasLive = true;
                } else {
                  title = (desc && desc.length >= 3 ? desc : (pick('meta[property="og:title"]') || pick('meta[name="twitter:title"]') || title));
                }
              }
              if (image) thumb.src = image; else { thumb.remove(); }
              const tnode = overlay.querySelector('.edgg-card-title');
              if (tnode) tnode.textContent = title;
              if (channel && wasLive) {
                try { startTwitchThumbAutoRefresh(thumb, channel, 60000, wrap); } catch (_) {}
              }
            } catch (_) { /* set minimal fallback */ try { thumb.remove(); } catch (_) {} }
          });
          return;
        }
      }

      // Kick (thumbnail + title overlay)
      if (STATE.settings.enableKick && /(^|\.)kick\.com$/i.test(host)) {
        const { channel: kChan, video: kVid } = extractKick(url);
        if (kChan || kVid) {
          const card = document.createElement('a');
          card.className = 'edgg-card edgg-card-kick';
          card.href = a.href;
          card.target = '_blank';
          card.rel = 'noopener noreferrer';
          card.style.maxWidth = '566px';
          card.style.width = widthPx + 'px';

          const thumb = document.createElement('img');
          thumb.className = 'edgg-card-thumb';
          thumb.alt = 'Open on Kick';
          thumb.style.display = 'block';
          thumb.style.width = '100%';
          card.appendChild(thumb);

          const overlay = document.createElement('div');
          overlay.className = 'edgg-card-overlay';
          overlay.innerHTML = '<div class="edgg-card-title-bg"></div><div class="edgg-card-title">Loading…</div>';
          card.appendChild(overlay);

          const wrap = document.createElement('div');
          wrap.className = 'edgg-wrap';
          wrap.appendChild(card);
          const scroller = getScrollContainer(container);
          const linkInView = isElementInView(container, scroller);
          const shouldStick = linkInView && (STATE.stickyWanted || isAtBottom(scroller, 2));
          // Auto-scroll fix: Use safeAppendEmbed instead of direct appendChild to preserve sticky state
          safeAppendEmbed(container, wrap, scroller, shouldStick);
          try { retargetLinks(wrap); } catch (_) {}

          // Fetch page metadata (title + image). Prefer live title if detectable.
          const fetchUrl = a.href;
          safeSendMessage({ type: 'bgFetch', url: fetchUrl }, (res) => {
            try {
              let title = kChan ? `Kick • ${kChan}` : `Kick Video`;
              let image = '';
              if (res && res.ok && res.body) {
                const doc = new DOMParser().parseFromString(res.body, 'text/html');
                const pick = (sel) => { const n = doc.querySelector(sel); return n ? (n.getAttribute('content') || '').trim() : ''; };
                image = pick('meta[property="og:image"]') || pick('meta[name="twitter:image"]');
                const desc = pick('meta[property="og:description"]') || pick('meta[name="twitter:description"]');
                const liveT = extractKickLiveTitle(res.body);
                if (liveT) title = liveT; else title = (desc && desc.length >= 3 ? desc : (pick('meta[property="og:title"]') || pick('meta[name="twitter:title"]') || title));
              }
              if (image) thumb.src = image; else { thumb.remove(); }
              const tn = overlay.querySelector('.edgg-card-title');
              if (tn) tn.textContent = title;
              if (wasLive && image) {
                try { startThumbAutoRefresh(thumb, image, 60000, wrap); } catch (_) {}
              }
            } catch (_) {}
          });
          return;
        }
      }
    }
  }

  // Resolve Imgur page (image, album, gifv) to direct media and embed
  /**
   * Resolve an Imgur gallery/image page into a direct media URL via og: tags
   * and embed it like a normal image/video element.
   */
  function resolveAndEmbedImgur(originUrl, container, widthPx, sensitivity) {
    try {
      safeSendMessage({ type: 'bgFetch', url: originUrl }, (res) => {
        if (!res || !res.ok || !res.body) return;
        try {
          const doc = new DOMParser().parseFromString(res.body, 'text/html');
          const pickMeta = (sel) => {
            const m = doc.querySelector(sel);
            return m ? (m.getAttribute('content') || '').trim() : '';
          };
          // Prefer video if available (gifv etc.)
          let videoUrl = '';
          videoUrl = pickMeta('meta[property="og:video:secure_url"]') || pickMeta('meta[property="og:video"]') || pickMeta('meta[name="twitter:player:stream"]');
          // Ensure it's a direct mp4/webm from i.imgur.com
          if (videoUrl && !/\.(mp4|webm)(?:$|\?)/i.test(videoUrl)) videoUrl = '';

          let imageUrl = '';
          imageUrl = pickMeta('meta[property="og:image:secure_url"]') || pickMeta('meta[property="og:image"]') || (doc.querySelector('link[rel="image_src"]') && doc.querySelector('link[rel="image_src"]').getAttribute('href')) || '';

          // Some og:image have sizing params; still fine. Ensure i.imgur.com
          const useVideo = !!videoUrl;
          if (useVideo) {
            const vid = document.createElement('video');
            vid.preload = 'metadata';
            vid.controls = true;
            vid.playsInline = true;
            vid.className = 'edgg-media';
            vid.style.maxWidth = '566px';
            vid.style.width = widthPx + 'px';
            const src = document.createElement('source');
            src.src = videoUrl;
            src.type = /\.webm(?:$|\?)/i.test(videoUrl) ? 'video/webm' : 'video/mp4';
            vid.appendChild(src);
            try { prepareVideoForCsp(vid, videoUrl); } catch (_) {}
            injectBelow(container, vid, originUrl, widthPx, sensitivity);
            return;
          }

          if (imageUrl) {
            const img = document.createElement('img');
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = imageUrl;
            img.className = 'edgg-media';
            img.style.maxWidth = '566px';
            injectBelow(container, img, originUrl, widthPx, sensitivity);
            return;
          }
        } catch (_) {}
      });
    } catch (_) {}
  }

  /** Resolve a Reddit post URL (comments link) and embed trimmed text + media. */
  function resolveAndEmbedReddit(originUrl, container, widthPx, sensitivity) {
    let apiUrl;
    try {
      const u = new URL(originUrl, location.href);
      // Ensure we fetch the JSON for the post
      const base = u.origin + u.pathname.replace(/\/?$/, '/') + '.json?raw_json=1';
      apiUrl = base;
    } catch (_) { apiUrl = originUrl + '.json?raw_json=1'; }

    safeSendMessage({ type: 'bgFetch', url: apiUrl }, (res) => {
      try {
        if (!res || !res.ok || !res.body) return;
        const json = JSON.parse(res.body);
        const post = Array.isArray(json) && json[0] && json[0].data && json[0].data.children && json[0].data.children[0]
          ? json[0].data.children[0].data
          : null;
        if (!post) return;

        const textRaw = String(post.selftext || post.title || '').trim();
        const textTrim = textRaw.length > 300 ? (textRaw.slice(0, 300) + '…') : textRaw;

        // Try to find media: reddit hosted video, image, or preview
        let videoUrl = null;
        let imageUrl = null;
        const unescape = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"');

        if (post.is_video && post.media && post.media.reddit_video && post.media.reddit_video.fallback_url) {
          videoUrl = post.media.reddit_video.fallback_url;
        } else if (post.secure_media && post.secure_media.reddit_video && post.secure_media.reddit_video.fallback_url) {
          videoUrl = post.secure_media.reddit_video.fallback_url;
        } else if (post.url && /\.(png|jpe?g|gif|webp)$/i.test(post.url)) {
          imageUrl = post.url;
        } else if (post.preview && post.preview.images && post.preview.images[0] && post.preview.images[0].source && post.preview.images[0].source.url) {
          imageUrl = unescape(post.preview.images[0].source.url);
        }

        const card = document.createElement('div');
        card.className = 'edgg-embed edgg-reddit';
        card.style.maxWidth = '566px';
        card.style.width = widthPx + 'px';

        const body = document.createElement('div');
        const header = document.createElement('div');
        header.className = 'edgg-tweet-header';
        const sub = String(post.subreddit_name_prefixed || post.subreddit || 'Reddit');
        header.innerHTML = `<span class="edgg-tweet-user">${escapeHtml(sub)}</span>`;
        const textEl = document.createElement('div');
        textEl.className = 'edgg-tweet-text';
        textEl.textContent = textTrim;
        body.appendChild(header);
        body.appendChild(textEl);

        if (videoUrl) {
          const vid = document.createElement('video');
          vid.preload = 'metadata';
          vid.controls = true;
          vid.playsInline = true;
          vid.className = 'edgg-media';
          vid.style.maxWidth = '566px';
          vid.style.width = widthPx + 'px';
          const src = document.createElement('source');
          src.src = videoUrl;
          src.type = 'video/mp4';
          vid.appendChild(src);
          try { prepareVideoForCsp(vid, videoUrl); } catch (_) {}
          const mediaWrap = document.createElement('div');
          mediaWrap.className = 'edgg-tweet-media';
          mediaWrap.appendChild(vid);
          body.appendChild(mediaWrap);
        } else if (imageUrl) {
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.decoding = 'async';
          img.src = imageUrl;
          img.className = 'edgg-media edgg-tweet-photo';
          const mediaWrap = document.createElement('div');
          mediaWrap.className = 'edgg-tweet-media';
          mediaWrap.appendChild(img);
          body.appendChild(mediaWrap);
        }

        const footer = document.createElement('div');
        footer.className = 'edgg-tweet-footer';
        footer.innerHTML = `<a href="${sanitizeRedditUrl(originUrl)}" target="_blank" rel="noopener noreferrer">Open on Reddit</a>`;
        body.appendChild(footer);

        card.appendChild(body);
        injectBelow(container, card, sanitizeRedditUrl(originUrl), widthPx, sensitivity);
      } catch (_) {}
    });
  }

  function sanitizeRedditUrl(u) {
    try {
      const url = new URL(u, location.href);
      // Remove tracking params if present
      ['utm_source','utm_medium','utm_campaign','utm_name','utm_term','utm_content'].forEach(k => url.searchParams.delete(k));
      return url.href;
    } catch (_) { return u; }
  }
  /** Resolve an Instagram page (post/reel) into media via canonical /p/ URL. */
  function resolveAndEmbedInstagram(originUrl, container, widthPx, sensitivity) {
    try {
      const primary = canonicalizeInstagramUrl(originUrl);
      console.log(primary);


      safeSendMessage({ type: 'bgFetch', url: primary }, (res) => {
        console.log(res);
        if (!res || !res.ok || !res.body) return;
        try {
          const doc = new DOMParser().parseFromString(res.body, 'text/html');
          const pick = (sel) => { const m = doc.querySelector(sel); return m ? (m.getAttribute('content') || '').trim() : ''; };

          let imageUrl = pick('meta[property="og:image"]') || pick('meta[name="twitter:image"]');
          let videoUrl = pick('meta[property="og:video:secure_url"]') || pick('meta[property="og:video"]') || pick('meta[name="twitter:player:stream"]');
          let videoType = pick('meta[property="og:video:type"]') || '';
          console.log(doc);
          console.log(pick);
          console.log(videoUrl);
          console.log(videoType);

          // Fallback: parse JSON-LD for contentUrl
          if (!videoUrl) {
            try {
              const ld = doc.querySelectorAll('script[type="application/ld+json"]');
              for (let i = 0; i < ld.length && !videoUrl; i++) {
                const txt = ld[i].textContent || '';
                const obj = JSON.parse(txt);
                const tryGrab = (o) => {
                  if (!o) return;
                  if (typeof o.contentUrl === 'string') videoUrl = o.contentUrl;
                  else if (o.video && typeof o.video.contentUrl === 'string') videoUrl = o.video.contentUrl;
                };
                if (Array.isArray(obj)) obj.forEach(tryGrab); else tryGrab(obj);
              }
            } catch (_) {}
          }

          // Fallback: search raw HTML for JSON keys or direct CDN MP4 when meta/JSON-LD missing
          if (!videoUrl) {
            try {
              const raw = res.body;
              let m = raw.match(/\"video_url\"\s*:\s*\"([^\"]+)\"/);
              if (m && m[1]) videoUrl = decodeJsonString(m[1]);
              if (!videoUrl) { m = raw.match(/\"playable_url\"\s*:\s*\"([^\"]+)\"/); if (m && m[1]) videoUrl = decodeJsonString(m[1]); }
              if (!videoUrl) { m = raw.match(/\"fallback_url\"\s*:\s*\"([^\"]+)\"/); if (m && m[1]) videoUrl = decodeJsonString(m[1]); }
              if (!videoUrl) {
                m = raw.match(/https?:\/\/[^"'\s]*cdninstagram\.com[^"'\s]*\.mp4[^"'\s]*/i);
                if (m && m[0]) videoUrl = m[0];
              }
            } catch (_) {}
          }

          // Try to extract caption text too
          const caption = extractInstagramCaption(res.body) || '';

          // Treat presence of a video URL as a video, even if it lacks an extension
          if (videoUrl) {
            const block = document.createElement('div');
            block.style.width = '100%';
            const vid = document.createElement('video');
            vid.preload = 'metadata';
            vid.controls = true;
            vid.playsInline = true;
            vid.className = 'edgg-media';
            vid.style.maxWidth = '566px';
            vid.style.width = widthPx + 'px';
            const src = document.createElement('source');
            src.src = videoUrl;
            // Best-effort MIME
            if (/webm/i.test(videoType) || /\.webm(?:$|\?)/i.test(videoUrl)) src.type = 'video/webm';
            else src.type = 'video/mp4';
            vid.appendChild(src);
            try { prepareVideoForCsp(vid, videoUrl); } catch (_) {}
            block.appendChild(vid);
            if (caption && caption.length > 0) {
              const cap = document.createElement('div');
              cap.className = 'edgg-card-meta edgg-ig-caption';
              cap.textContent = caption;
              block.appendChild(cap);
            }
            // Use canonical /p/ URL as the embed's origin link, while leaving the message text untouched
            injectBelow(container, block, primary, widthPx, sensitivity);
            return;
          }

          // Try ddinstagram mirror first when no direct video found
          const altUrl = buildDdInstagramUrl(primary);
          if (altUrl) {
            safeSendMessage({ type: 'bgFetch', url: altUrl }, (r2) => {
              try {
                if (!r2 || !r2.ok || !r2.body) {
                  if (imageUrl) {
                    const block = document.createElement('div');
                    block.style.width = '100%';
                    const img = document.createElement('img');
                    img.loading = 'lazy';
                    img.decoding = 'async';
                    img.src = imageUrl;
                    img.className = 'edgg-media';
                    img.style.maxWidth = '566px';
                    block.appendChild(img);
                    const cap = extractInstagramCaption(res.body);
                    if (cap) { const cEl = document.createElement('div'); cEl.className = 'edgg-card-meta edgg-ig-caption'; cEl.textContent = cap; block.appendChild(cEl); }
                    injectBelow(container, block, primary, widthPx, sensitivity);
                  }
                  return;
                }
                const d2 = new DOMParser().parseFromString(r2.body, 'text/html');
                const pick2 = (sel) => { const m2 = d2.querySelector(sel); return m2 ? (m2.getAttribute('content') || '').trim() : ''; };
                const v2 = pick2('meta[property="og:video:secure_url"]') || pick2('meta[property="og:video"]');
                const t2 = pick2('meta[property="og:video:type"]');
                const i2 = pick2('meta[property="og:image"]');
                if (v2) {
                  const block2 = document.createElement('div');
                  block2.style.width = '100%';
                  const vid2 = document.createElement('video');
                  vid2.preload = 'metadata';
                  vid2.controls = true;
                  vid2.playsInline = true;
                  vid2.className = 'edgg-media';
                  vid2.style.maxWidth = '566px';
                  vid2.style.width = widthPx + 'px';
                  const s2 = document.createElement('source');
                  s2.src = v2;
                  if (/webm/i.test(t2) || /\.webm(?:$|\?)/i.test(v2)) s2.type = 'video/webm'; else s2.type = 'video/mp4';
                  vid2.appendChild(s2);
                  try { prepareVideoForCsp(vid2, v2); } catch (_) {}
                  block2.appendChild(vid2);
                  const cap2 = extractInstagramCaption(r2.body);
                  if (cap2) { const c2 = document.createElement('div'); c2.className = 'edgg-card-meta edgg-ig-caption'; c2.textContent = cap2; block2.appendChild(c2); }
                  injectBelow(container, block2, primary, widthPx, sensitivity);
                  return;
                }
                if (i2) {
                  const block3 = document.createElement('div');
                  block3.style.width = '100%';
                  const im2 = document.createElement('img');
                  im2.loading = 'lazy';
                  im2.decoding = 'async';
                  im2.src = i2;
                  im2.className = 'edgg-media';
                  im2.style.maxWidth = '566px';
                  block3.appendChild(im2);
                  const cap3 = extractInstagramCaption(r2.body);
                  if (cap3) { const c3 = document.createElement('div'); c3.className = 'edgg-card-meta edgg-ig-caption'; c3.textContent = cap3; block3.appendChild(c3); }
                  injectBelow(container, block3, primary, widthPx, sensitivity);
                  return;
                }
                // As a last resort, fallback to original image if available
                if (imageUrl) {
                  const block4 = document.createElement('div');
                  block4.style.width = '100%';
                  const img = document.createElement('img');
                  img.loading = 'lazy';
                  img.decoding = 'async';
                  img.src = imageUrl;
                  img.className = 'edgg-media';
                  img.style.maxWidth = '566px';
                  block4.appendChild(img);
                  const cap4 = extractInstagramCaption(res.body);
                  if (cap4) { const c4 = document.createElement('div'); c4.className = 'edgg-card-meta edgg-ig-caption'; c4.textContent = cap4; block4.appendChild(c4); }
                  injectBelow(container, block4, primary, widthPx, sensitivity);
                }
              } catch (_) {
                if (imageUrl) {
                  const block5 = document.createElement('div');
                  block5.style.width = '100%';
                  const img = document.createElement('img');
                  img.loading = 'lazy';
                  img.decoding = 'async';
                  img.src = imageUrl;
                  img.className = 'edgg-media';
                  img.style.maxWidth = '566px';
                  block5.appendChild(img);
                  const cap5 = extractInstagramCaption(res.body);
                  if (cap5) { const c5 = document.createElement('div'); c5.className = 'edgg-card-meta edgg-ig-caption'; c5.textContent = cap5; block5.appendChild(c5); }
                  injectBelow(container, block5, primary, widthPx, sensitivity);
                }
              }
            });
            return;
          }

          if (imageUrl) {
            const img = document.createElement('img');
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = imageUrl;
            img.className = 'edgg-media';
            img.style.maxWidth = '566px';
            injectBelow(container, img, primary, widthPx, sensitivity);
            return;
          }
        } catch (_) {}
      });
    } catch (_) {}
  }

  // Map Instagram reels/reel URLs to canonical /p/<id> post URLs so OG tags resolve reliably
  function canonicalizeInstagramUrl(u) {
    try {
      const url = new URL(u, location.href);
      url.hostname = url.hostname.replace(/^www\./, '');
      if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return u;
      url.pathname = url.pathname.replace(/^\/reels\//i, '/p/').replace(/^\/reel\//i, '/p/');
      return url.href;
    } catch (_) { return u; }
  }

  /**
   * Render a normalized tweet JSON object into an existing tweet card element.
   * Accepts fields from Twitter's widget CDN and Fx/VxTwitter enrichment.
   */
  function renderTweetInto(cardEl, data, originUrl) {
    var body = cardEl.querySelector('.edgg-tweet-body') || cardEl;
    // Capture any existing rendered text HTML so we can preserve it if
    // a second-pass render (e.g., CDN JSON) lacks body text (common for replies).
    var prevTextHtml = '';
    var prevUserText = '';
    try {
      var prevTextNode = body.querySelector('.edgg-tweet-text');
      if (prevTextNode) prevTextHtml = String(prevTextNode.innerHTML || '');
      var prevUserNode = body.querySelector('.edgg-tweet-user');
      if (prevUserNode) prevUserText = String(prevUserNode.textContent || '');
    } catch (_) {}

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
      else if (data.oembed_html) {
        try {
          const tmp = document.createElement('div');
          tmp.innerHTML = data.oembed_html;
          const p = tmp.querySelector('blockquote p');
          // Prefer innerHTML to preserve anchors from oEmbed
          if (p) text = p.innerHTML || (p.textContent || '');
        } catch (_) {}
      }
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

    // Videos (normalized from background)
    var videos = [];
    if (data) {
      if (Array.isArray(data.videos)) videos = data.videos;
      else if (Array.isArray(data.video_urls)) {
        videos = data.video_urls.map(function(u){ return { url: String(u), type: 'video/mp4' }; });
      } else if (typeof data.video_url === 'string' && data.video_url) {
        videos = [{ url: String(data.video_url), type: 'video/mp4' }];
      }
    }

    if (!userName && prevUserText) userName = prevUserText;
    var safeUser = escapeHtml(String(userName || ''));
    // Build final text HTML. If we already have HTML from a prior oEmbed
    // render and this pass has no plain text, preserve the previous HTML.
    var textHtml = '';
    if (text && /<\w+[^>]*>/.test(text)) {
      // Text already contains HTML from oEmbed
      textHtml = String(text);
    } else if (text && text.trim()) {
      textHtml = escapeHtml(String(text))
        .replace(/https?:\/\/\S+/g, function(m){
          return '<a href="' + m + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(m) + '</a>';
        });
    } else if (prevTextHtml) {
      textHtml = prevTextHtml;
    }

    var mediaHtml = '';
    var mediaNodes = [];
    if (photos && photos.length) {
      for (var j = 0; j < Math.min(4, photos.length); j++) {
        var p = photos[j];
        var u = null;
        if (p) {
          if (p.url) u = String(p.url);
          else if (p.media_url_https) u = String(p.media_url_https);
          else if (p.media_url) u = String(p.media_url);
          else if (p.src) u = String(p.src);
        }
        if (u) mediaNodes.push('<img class="edgg-media edgg-tweet-photo" loading="lazy" decoding="async" src="' + u + '">');
      }
    }
    if (videos && videos.length) {
      for (var vj = 0; vj < Math.min(2, videos.length); vj++) {
        var v = videos[vj];
        var vu = v && (v.url || v.src) ? String(v.url || v.src) : null;
        if (vu && /https?:\/\/video\.twimg\.com\//.test(vu) && /\.mp4(?:$|\?)/.test(vu)) {
          mediaNodes.push(
            '<video class="edgg-media edgg-tweet-video" controls preload="metadata" playsinline>' +
              '<source src="' + vu + '" type="video/mp4">' +
            '</video>'
          );
        }
      }
    }
    // If media is present, remove pic.twitter.com shortlinks from text to avoid duplicate link-only display
    if (mediaNodes.length || (photos && photos.length) || (videos && videos.length)) {
      try {
        textHtml = String(textHtml || '')
          .replace(/<a[^>]+href=\"https?:\/\/pic\.twitter\.com\/[^\"]+\"[^>]*>[^<]*<\/a>/ig, '');
      } catch (_) {}
    }
    if (mediaNodes.length) {
      mediaHtml = '<div class="edgg-tweet-media">' + mediaNodes.join('') + '</div>';
    }

    var created = '';
    if (data) {
      if (data.created_at) created = String(data.created_at);
      else if (data.date) created = String(data.date);
    }

    body.innerHTML =
      '<div class="edgg-tweet-header">' + (safeUser ? '<span class="edgg-tweet-user">' + safeUser + '</span>' : '') + '</div>' +
      '<div class="edgg-tweet-text">' + (textHtml || '') + '</div>' +
      mediaHtml +
      '<div class="edgg-tweet-footer">' +
        '<a href="' + originUrl + '" target="_blank" rel="noopener noreferrer">Open on Twitter</a>' +
        (created ? ' • <span class="edgg-tweet-date">' + escapeHtml(created) + '</span>' : '') +
      '</div>';

    // Ensure all links open in a new tab and expand t.co shortlinks inside text
    try { retargetLinks(body); } catch (_) {}
    try { expandTcoLinksIn(body); } catch (_) {}

    // If images load later, keep bottom locked
    var imgs2 = body.querySelectorAll('img,video');
    for (var k = 0; k < imgs2.length; k++) {
      var evName = imgs2[k].tagName === 'VIDEO' ? 'loadedmetadata' : 'load';
      imgs2[k].addEventListener(evName, function(){
        var scroller = getScrollContainer(cardEl);
        if (isAtBottom(scroller)) scrollToBottom(scroller);
      }, { once: true });
    }

    // Ensure CSP-safe videos (convert to blob: if needed)
    try { ensureCspSafeVideos(body); } catch (_) {}

    // Apply spoiler overlays if enabled or sensitivity tagged
    try {
      var wrap = cardEl.closest && cardEl.closest('.edgg-wrap');
      var label = wrap && wrap.getAttribute('data-edgg-sensitivity');
      applySpoilersInRoot(body, label, STATE.settings.blurMedia || !!label);
    } catch (_) {}
    
    // Initialize pager if multiple media present (after spoiler setup)
    try { initTweetMediaPager(body); } catch (_) {}
  }

  /**
   * Insert an embed wrapper directly below the message container, maintain
   * sticky scroll when appropriate, and apply spoiler overlays.
   */
  function injectBelow(container, el, originUrl, desiredWidthPx, sensitivityLabel) {
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
    wrap.className = "edgg-wrap edgg-left";
    if (originUrl) wrap.setAttribute("data-edgg-origin", originUrl);
    if (sensitivityLabel) wrap.setAttribute('data-edgg-sensitivity', sensitivityLabel);
    if (desiredWidthPx && Number.isFinite(desiredWidthPx)) {
      wrap.style.maxWidth = "566px";
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
    // Auto-scroll fix: Use safeAppendEmbed instead of direct appendChild to preserve sticky state
    safeAppendEmbed(container, wrap, scroller, shouldStick);

    // Enforce target="_blank" for any anchors inside our wrapper
    try { retargetLinks(wrap); } catch (_) {}

    // Convert blocked cross-origin videos to blob: if needed (for CSP)
    try { ensureCspSafeVideos(wrap); } catch (_) {}

    // Apply spoiler/blur overlay if enabled or sensitivity-tagged
    try { applySpoilerIfNeeded(wrap, sensitivityLabel, STATE.settings.blurMedia || !!sensitivityLabel); } catch (_) {}
  }

  /** Compute a reasonable embed width based on chat layout (max 566px). */
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

  /** Extract a YouTube video id from common URL shapes. */
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

  /** Extract Twitch channel or VOD id from URL. */
  function extractTwitch(u) {
    // twitch.tv/<channel> or twitch.tv/videos/<id>
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "videos" && parts[1]) return { channel: null, video: parts[1] };
    if (parts[0]) return { channel: parts[0], video: null };
    return { channel: null, video: null };
  }

  /** Extract Kick channel or video id from URL. */
  function extractKick(u) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return { channel: null, video: null };
    if ((parts[0] === 'video' || parts[0] === 'videos') && parts[1]) return { channel: null, video: parts[1] };
    return { channel: parts[0] || null, video: null };
  }

  /** Try to pull a live stream title from a Kick channel HTML response. */
  function extractKickLiveTitle(html) {
    try {
      if (!html || typeof html !== 'string') return null;
      // Heuristics: look for is_live true near a title/session_title/name field
      let m = html.match(/"is_live"\s*:\s*true[\s\S]{0,20000}?"(session_title|title|name)"\s*:\s*"([^"]{1,400})"/i);
      if (!m) m = html.match(/"(session_title|title|name)"\s*:\s*"([^"]{1,400})"[\s\S]{0,20000}?"is_live"\s*:\s*true/i);
      if (m && m[2]) return decodeJsonString(m[2]).trim();
    } catch (_) {}
    return null;
  }

  /** Build a Twitch live preview image URL for a channel. */
  function getTwitchLivePreviewUrl(channel, w = 640, h = 360) {
    try {
      const c = String(channel || '').toLowerCase();
      if (!c) return '';
      return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(c)}-${w}x${h}.jpg`;
    } catch (_) { return ''; }
  }
  function buildDdInstagramUrl(u) {
    try {
      const url = new URL(u, location.href);
      url.hostname = url.hostname.replace(/^www\./, '');
      if (!/instagram\.com$/i.test(url.hostname)) return null;
      const alt = new URL(u, location.href);
      alt.hostname = 'ddinstagram.com';
      // Path is already canonicalized to /p/<id> upstream
      return alt.href;
    } catch (_) { return null; }
  }

  // Try to extract Instagram caption text from HTML body
  function extractInstagramCaption(html) {
    try {
      if (!html || typeof html !== 'string') return '';
      const tryRe = (re) => { const m = html.match(re); return (m && m[1]) ? decodeJsonString(m[1]) : ''; };
      // Common shapes
      let cap = tryRe(/\"edge_media_to_caption\"\s*:\s*\{\s*\"edges\"\s*:\s*\[\s*\{\s*\"node\"\s*:\s*\{\s*\"text\"\s*:\s*\"([^\"]{1,2000})\"/);
      if (cap) return cap;
      cap = tryRe(/\"caption\"\s*:\s*\"([^\"]{1,2000})\"/);
      if (cap) return cap;
      cap = tryRe(/\"caption\"\s*:\s*\{\s*\"text\"\s*:\s*\"([^\"]{1,2000})\"/);
      if (cap) return cap;
      cap = tryRe(/\"accessibility_caption\"\s*:\s*\"([^\"]{1,2000})\"/);
      if (cap) return cap;
      // Fallback to meta descriptions (may include more text)
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const meta = (sel) => { const n = doc.querySelector(sel); return n ? (n.getAttribute('content') || '').trim() : ''; };
      cap = meta('meta[name="description"]') || meta('meta[property="og:description"]') || '';
      return cap;
    } catch (_) { return ''; }
  }

  // Hosts that commonly get blocked by the page CSP; fetch to blob: instead of direct loading
  function isCspBlockedHost(hostname) {
    try {
      const h = String(hostname || '').toLowerCase();
      return /(^|\.)files\.catbox\.moe$/.test(h) || /(^|\.)video\.twimg\.com$/.test(h) || /(^|\.)v\.redd\.it$/.test(h) || /cdninstagram\.com$/.test(h);
    } catch (_) { return false; }
  }

  /**
   * Periodically refresh a Twitch live preview thumbnail so it stays up-to-date
   * while the channel is live. Stops automatically if the image is detached.
   */
  function startTwitchThumbAutoRefresh(imgEl, channel, periodMs = 60000, scopeEl = null) {
    try {
      if (!imgEl || !channel) return;
      // Clear any prior timer bound to this element
      if (imgEl.__edggTwTimer) { try { clearInterval(imgEl.__edggTwTimer); } catch (_) {} }

      const update = () => {
        try {
          if (!imgEl.isConnected) { clearInterval(imgEl.__edggTwTimer); imgEl.__edggTwTimer = null; return; }
          const wrap = scopeEl || imgEl.closest('.edgg-wrap') || imgEl.parentElement;
          const scroller = getScrollContainer(wrap || imgEl);
          if (wrap && scroller && !isElementInView(wrap, scroller)) return; // skip when off-screen
          const base = getTwitchLivePreviewUrl(channel, 640, 360);
          if (!base) return;
          imgEl.src = base + `?t=${Date.now()}`;
        } catch (_) {}
      };
      // Kick immediately, then schedule
      update();
      imgEl.__edggTwTimer = setInterval(update, Math.max(15000, periodMs | 0));
    } catch (_) {}
  }

  /** Generic periodic refresh for a thumbnail image using a base URL. */
  function startThumbAutoRefresh(imgEl, baseUrl, periodMs = 60000, scopeEl = null) {
    try {
      if (!imgEl || !baseUrl) return;
      if (imgEl.__edggThumbTimer) { try { clearInterval(imgEl.__edggThumbTimer); } catch (_) {} }
      const update = () => {
        try {
          if (!imgEl.isConnected) { clearInterval(imgEl.__edggThumbTimer); imgEl.__edggThumbTimer = null; return; }
          const wrap = scopeEl || imgEl.closest('.edgg-wrap') || imgEl.parentElement;
          const scroller = getScrollContainer(wrap || imgEl);
          if (wrap && scroller && !isElementInView(wrap, scroller)) return; // skip when off-screen
          imgEl.src = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        } catch (_) {}
      };
      update();
      imgEl.__edggThumbTimer = setInterval(update, Math.max(15000, periodMs | 0));
    } catch (_) {}
  }

  /** Heuristic to determine if a YouTube watch page is live. */
  function isYouTubeLive(html) {
    try {
      if (!html || typeof html !== 'string') return false;
      if (/"isLiveContent"\s*:\s*true/i.test(html)) return true;
      if (/itemprop=\"isLiveBroadcast\"[^>]*content=\"(True|true)\"/i.test(html)) return true;
      if (/"isLiveNow"\s*:\s*true/i.test(html)) return true;
    } catch (_) {}
    return false;
  }

  // Read DGG chat settings that affect embedding of NSFW/NSFL content
  function isHideNsflEnabled() {
    try { const el = document.querySelector('input[name="hidensfl"]'); return !!(el && el.checked); } catch (_) { return false; }
  }
  function isHideNsfwEnabled() {
    try { const el = document.querySelector('input[name="hidensfw"]'); return !!(el && el.checked); } catch (_) { return false; }
  }
  function getShowRemovedSetting() {
    try { const sel = document.getElementById('showremoved'); return sel ? String(sel.value) : ''; } catch (_) { return ''; }
  }

  /**
   * Try to pull the live stream title from a Twitch channel HTML response.
   * This uses heuristics to find a nearby "isLive":true and a "title":"...".
   * Returns a decoded string if found; otherwise null.
   */
  function extractTwitchLiveTitle(html) {
    try {
      if (!html || typeof html !== 'string') return null;
      // Look for a window where isLive:true appears near a title field
      let m = html.match(/\"isLive\"\s*:\s*true[\s\S]{0,20000}?\"title\"\s*:\s*\"([^\"]{1,400})\"/i);
      if (!m) {
        // Reverse order: title appears before isLive:true
        const m2 = html.match(/\"title\"\s*:\s*\"([^\"]{1,400})\"[\s\S]{0,20000}?\"isLive\"\s*:\s*true/i);
        if (m2) m = m2;
      }
      if (!m) m = html.match(/\"isLiveBroadcast\"\s*:\s*true[\s\S]{0,20000}?\"name\"\s*:\s*\"([^\"]{1,400})\"/i);
      if (!m) m = html.match(/\"broadcastSettings\"\s*:\s*\{[\s\S]*?\"title\"\s*:\s*\"([^\"]{1,400})\"[\s\S]{0,20000}?\}/i);
      if (!m) m = html.match(/\"streamTitle\"\s*:\s*\"([^\"]{1,400})\"[\s\S]{0,20000}?\"isLive\"\s*:\s*true/i);
      if (m && m[1]) {
        return decodeJsonString(m[1]).trim();
      }
    } catch (_) {}
    return null;
  }

  /** Decode common JSON string escapes (\\uXXXX, \\" and \\\\). */
  function decodeJsonString(s) {
    try {
      // Wrap and parse via JSON to handle escapes safely
      return JSON.parse('"' + String(s).replace(/"/g, '\\"') + '"');
    } catch (_) {
      // Fallback manual unescape
      return String(s)
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
  }

  /**
   * Extract a Twitch channel from a DGG bigscreen link hash or from link text
   * formatted like "#twitchxqc" or "#twitch/xqc".
   */
  function extractDggBigscreenTwitch(u, linkText) {
    try {
      // Only consider bigscreen links for hash parsing
      const isDgg = /(\.|^)destiny\.gg$/i.test(u.hostname) && u.pathname.startsWith('/bigscreen');
      if (isDgg && typeof u.hash === 'string' && u.hash) {
        // Require the slash form: #twitch/<channel>
        const m = u.hash.match(/^#twitch\/([a-z0-9_]+)/i);
        if (m && m[1]) return m[1];
      }
    } catch (_) {}
    try {
      const t = (linkText || '').trim();
      if (!t) return null;
      // Accept only the slash form: #twitch/<channel>
      const m2 = t.match(/^#twitch\/([a-z0-9_]+)$/i);
      if (m2 && m2[1]) return m2[1];
    } catch (_) {}
    return null;
  }

  /** Minimal attribute‑safe escape for selector usage. */
  function cssEscape(s) {
    return s.replace(/"/g, '\\"');
  }

  /** Basic HTML escape for text interpolation. */
  function escapeHtml(s) {
    return String(s).replace(/[&<>\"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Hover preview removed

  // ---- Auto-scroll helpers ----
  /** Return true if an element is visibly within a scroller viewport. */
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
  
  /**
   * Reveal all spoilers within the same tweet container when one is revealed.
   * This ensures that clicking reveal on any image/video reveals all media in that tweet.
   */
  function revealAllInTweet(triggerElement) {
    // Find the parent tweet media container
    const tweetContainer = triggerElement.closest('.edgg-tweet-media');
    if (!tweetContainer) return;
    
    // Find all spoiler elements within this tweet
    const spoilers = tweetContainer.querySelectorAll('.edgg-spoiler:not(.edgg-spoiler-revealed)');
    spoilers.forEach(spoiler => {
      const media = spoiler.querySelector('img.edgg-media, video.edgg-media, iframe.edgg-media');
      const cover = spoiler.querySelector('.edgg-spoiler-cover');
      
      if (media) {
        media.classList.remove('edgg-spoiler-blur');
        spoiler.classList.add('edgg-spoiler-revealed');
        if (cover && cover.parentNode) cover.parentNode.removeChild(cover);
      }
    });
    
    // Also handle wrapper-style spoilers (for single media containers)
    const wrapSpoilers = tweetContainer.querySelectorAll('.edgg-wrap.edgg-spoiler:not(.edgg-spoiler-revealed)');
    wrapSpoilers.forEach(wrap => {
      const media = wrap.querySelector('img.edgg-media, video.edgg-media, iframe.edgg-media');
      const cover = wrap.querySelector('.edgg-spoiler-cover');
      
      if (media) {
        media.classList.remove('edgg-spoiler-blur');
        wrap.classList.remove('edgg-spoiler');
        wrap.classList.add('edgg-spoiler-revealed');
        if (cover && cover.parentNode) cover.parentNode.removeChild(cover);
      }
    });
  }
  
  // Detect NSFW/NSFL flag from the message element
  /**
   * Derive a sensitivity label (NSFW/NSFL) from the message text. Used to
   * force a spoiler overlay and to customize its label.
   */
  function getSensitivityLabel(container) {
    try {
      const text = (container && (container.innerText || container.textContent)) ? String(container.innerText || container.textContent).toLowerCase() : '';
      if (/\bnsfl\b/.test(text)) return 'NSFL';
      if (/\bnsfw\b/.test(text)) return 'NSFW';
    } catch (_) {}
    return null;
  }

  /**
   * Add a spoiler overlay on top of a single media element wrapper. When
   * `force` is true we show the overlay even if blur is disabled globally.
   */
  function applySpoilerIfNeeded(wrap, label, force = false) {
    if (!wrap || !(wrap instanceof HTMLElement)) return;
    // Blur direct image/video/iframe content
    const media = wrap.querySelector('img, video, iframe');
    if (!media) return;
    if (!STATE.settings.blurMedia && !force) return;
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
    const icon = document.createElement('span');
    icon.className = 'edgg-spoiler-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '👁️';
    txt.appendChild(icon);
    const prefix = (typeof label === 'string' && label) ? (label.toUpperCase() + ' - ') : '';
    txt.appendChild(document.createTextNode(prefix + 'Click to reveal'));
    cover.appendChild(txt);
    cover.title = 'Sensitive media — click to reveal';
    wrap.appendChild(cover);

    const reveal = () => {
      // Reveal all spoilers in the same tweet instead of just this one
      revealAllInTweet(media);
    };

    cover.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); reveal(); }, true);
    cover.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); reveal(); }
    }, true);
  }

  /** Apply spoiler overlays for all media nodes found under a root element. */
  function applySpoilersInRoot(root, label, force = false) {
    if (!STATE.settings.blurMedia && !force) return;
    if (!root || !root.querySelectorAll) return;
    const nodes = root.querySelectorAll('img.edgg-media, video.edgg-media, iframe.edgg-media');
    nodes.forEach((m) => {
      if (!(m instanceof HTMLElement)) return;
      // If already within an edgg-spoiler wrapper, skip
      if (m.closest('.edgg-spoiler-revealed') || m.closest('.edgg-spoiler-cover')) return;
      let parent = m.parentElement;
      if (!parent) return;

      // If the immediate parent is a single-media container (like our wrap), use overlay approach
      if (parent.classList && parent.classList.contains('edgg-wrap')) {
        applySpoilerIfNeeded(parent, label, force);
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
      const icon = document.createElement('span');
      icon.className = 'edgg-spoiler-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '👁️';
      txt.appendChild(icon);
      const prefix = (typeof label === 'string' && label) ? (label.toUpperCase() + ' - ') : '';
      txt.appendChild(document.createTextNode(prefix + 'Click to reveal'));
      cover.appendChild(txt);
      cover.title = 'Sensitive media — click to reveal';
      holder.appendChild(cover);

      const reveal = () => {
        m.classList.remove('edgg-spoiler-blur');
        holder.classList.add('edgg-spoiler-revealed');
        if (cover && cover.parentNode) cover.parentNode.removeChild(cover);
      };
      cover.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); revealAllInTweet(m); }, true);
      cover.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); revealAllInTweet(m); }
      }, true);
    });
  }
  /**
   * Safely append an embed wrapper while preserving sticky scroll state.
   * 
   * Auto-scroll fix: When embeds are inserted into the DOM, they can cause temporary
   * scroll position changes that trigger the scroll handler, which would incorrectly
   * set STATE.stickyWanted to false even when the user was at the bottom of the chat.
   * This function prevents that by temporarily disabling the scroll handler during
   * embed insertion and preserving the original sticky state.
   * 
   * @param {Element} container - The chat message container to append to
   * @param {Element} wrap - The embed wrapper element to append
   * @param {Element} scroller - The scrollable container element
   * @param {boolean} shouldStick - Whether auto-scroll should be maintained
   */
  function safeAppendEmbed(container, wrap, scroller, shouldStick) {
    // Save the current sticky state before insertion
    const wasStickyWanted = STATE.stickyWanted;
    
    // Temporarily disable scroll handler to prevent it from updating stickyWanted
    STATE.insertingEmbed = true;
    
    try {
      // Insert the embed into the DOM
      container.appendChild(wrap);
    } finally {
      // Re-enable scroll handler
      STATE.insertingEmbed = false;
      
      // Restore stickyWanted if it was true before insertion - this prevents
      // the temporary scroll position changes from disabling auto-scroll
      if (wasStickyWanted) {
        STATE.stickyWanted = true;
      }
    }
    
    // Handle maintaining scroll position as embed content loads
    maintainStickyAfterAppend(scroller, shouldStick, wrap);
  }
  
  /**
   * If the user intends to be at the bottom, preserve bottom positioning while
   * async media load and resize events occur.
   */
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
  /** Find the nearest scrollable ancestor for a given element. */
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

  /** True if scroller is within `threshold` px of the bottom. */
  function isAtBottom(scroller, threshold = 32) {
    return (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) <= threshold;
  }

  /** Snap the scroller to its bottom. */
  function scrollToBottom(scroller) {
    scroller.scrollTop = scroller.scrollHeight;
  }

  // Hover preview removed

  // ---- CSP helpers: convert blocked cross-origin video to blob: URLs ----
  /** Attempt to read the original URL for a <video> (either src or <source>). */
  function getVideoOriginalUrl(v) {
    try {
      if (v && v.src && !v.src.startsWith('blob:')) return v.src;
    } catch (_) {}
    try {
      const s = v && v.querySelector && v.querySelector('source');
      if (s && s.src) return s.src;
    } catch (_) {}
    return null;
  }

  /**
   * Convert a video source to a blob: URL if the page CSP would block direct
   * cross‑origin playback (e.g., files.catbox.moe). We fetch the binary and
   * swap the src so the browser plays from a blob: URL (allowed by CSP).
   */
  function prepareVideoForCsp(videoEl, originUrl) {
    if (!videoEl || videoEl.__edggCspReady) return;
    videoEl.__edggCspReady = true;

    const url = originUrl || getVideoOriginalUrl(videoEl);
    if (!url || url.startsWith('blob:')) return;

    const toBlob = async () => {
      try {
        const resp = await fetch(url, { credentials: 'omit', cache: 'no-store', mode: 'cors' });
        if (!resp.ok) return;
        const blob = await resp.blob();
        const objUrl = URL.createObjectURL(blob);
        // Remove <source> children and set direct src
        try { while (videoEl.firstChild) videoEl.removeChild(videoEl.firstChild); } catch (_) {}
        videoEl.src = objUrl;
        videoEl.setAttribute('data-edgg-blob-src', objUrl);
        // No autoplay; user clicks play as before
        videoEl.load();
      } catch (_) { /* ignore */ }
    };

    // Fallback on error
    const onErr = () => {
      videoEl.removeEventListener('error', onErr);
      toBlob();
    };
    videoEl.addEventListener('error', onErr, { once: true });

    // Preemptively blob-ify for commonly blocked hosts
    try {
      const h = new URL(url, location.href).hostname.replace(/^www\./, '').toLowerCase();
      if (/^(files\.catbox\.moe|video\.twimg\.com|v\.redd\.it|.*\.cdninstagram\.com)$/i.test(h)) {
        // kick off without waiting for error
        toBlob();
      }
    } catch (_) {}
  }

  /** Apply CSP safety (blob: fallback) to all videos under a DOM root. */
  function ensureCspSafeVideos(root) {
    if (!root || !root.querySelectorAll) return;
    const vids = root.querySelectorAll('video');
    for (let i = 0; i < vids.length; i++) {
      const v = vids[i];
      const u = getVideoOriginalUrl(v);
      try { prepareVideoForCsp(v, u); } catch (_) {}
    }
  }

  /**
   * Initialize a simple pager on any `.edgg-tweet-media` container under `root`
   * that holds more than one media element. Shows one at a time with prev/next
   * buttons and a small counter. Idempotent per container.
   */
  function initTweetMediaPager(root) {
    if (!root || !root.querySelectorAll) return;
    const groups = root.querySelectorAll('.edgg-tweet-media');
    groups.forEach((group) => {
      try {
        if (!(group instanceof HTMLElement)) return;
        if (group.getAttribute('data-edgg-pager') === '1') return; // already initialized
        const items = Array.from(group.querySelectorAll('img.edgg-media, video.edgg-media'));
        if (!items || items.length <= 1) return;

        group.setAttribute('data-edgg-pager', '1');
        group.classList.add('edgg-pager');
        let idx = 0;
        
        // Show only one item at a time
        const show = (i) => {
          if (!items || !items.length) return;
          const n = items.length;
          // Clamp to valid range instead of wrapping
          idx = Math.max(0, Math.min(i, n - 1));
          for (let k = 0; k < n; k++) {
            const el = items[k];
            const on = (k === idx);
            // If spoiler wrapper exists, toggle that; else toggle media element
            let holder = null;
            try { holder = el.closest && el.closest('.edgg-spoiler'); } catch (_) {}
            const node = holder || el;
            node.style.display = on ? 'block' : 'none';
            // Pause any playing video when hidden
            try { if (!on && el.tagName === 'VIDEO') el.pause(); } catch (_) {}
          }
          try { counter.textContent = (idx + 1) + ' / ' + n; } catch (_) {}
          updateButtonVisibility();
        };

        // Prepare nav UI
        const prev = document.createElement('button');
        prev.className = 'edgg-pager-btn edgg-pager-prev';
        prev.setAttribute('aria-label', 'Previous media');
        prev.type = 'button';
        prev.tabIndex = -1; // Prevent focus scrolling
        prev.textContent = '‹';

        const next = document.createElement('button');
        next.className = 'edgg-pager-btn edgg-pager-next';
        next.setAttribute('aria-label', 'Next media');
        next.type = 'button';
        next.tabIndex = -1; // Prevent focus scrolling
        next.textContent = '›';

        const counter = document.createElement('div');
        counter.className = 'edgg-pager-counter';

        // Complete scroll position lock during pager operations
        const safePageTo = (newIdx) => {
          const scroller = getScrollContainer(group);
          const wasInserting = STATE.insertingEmbed;
          const wasStickyWanted = STATE.stickyWanted;
          
          // Capture current scroll position before any changes
          const savedScrollTop = scroller.scrollTop;
          
          // Disable scroll monitoring completely
          STATE.insertingEmbed = true;
          
          // Perform the page change
          show(newIdx);
          
          // Immediately restore exact scroll position - no movement allowed
          scroller.scrollTop = savedScrollTop;
          
          // Use requestAnimationFrame to handle any async height changes
          requestAnimationFrame(() => {
            scroller.scrollTop = savedScrollTop;
            
            // Double-check after another frame in case of delayed layout
            requestAnimationFrame(() => {
              scroller.scrollTop = savedScrollTop;
              
              // Restore state after position is locked
              STATE.stickyWanted = wasStickyWanted;
              STATE.insertingEmbed = wasInserting;
            });
          });
        };

        prev.addEventListener('click', (ev) => { 
          ev.preventDefault(); 
          ev.stopPropagation(); 
          ev.stopImmediatePropagation();
          safePageTo(idx - 1);
        }, true);
        
        next.addEventListener('click', (ev) => { 
          ev.preventDefault(); 
          ev.stopPropagation(); 
          ev.stopImmediatePropagation();
          safePageTo(idx + 1);
        }, true);

        // Optional: click on media advances to next (if not at end)
        items.forEach((el) => {
          el.addEventListener('click', (ev) => {
            // don't hijack clicks on embedded controls (e.g., video controls)
            if (el.tagName === 'VIDEO') return;
            // Only advance if not at the last item
            if (idx < items.length - 1) {
              ev.preventDefault();
              ev.stopPropagation();
              safePageTo(idx + 1);
            }
          }, true);
        });

        group.appendChild(prev);
        group.appendChild(next);
        group.appendChild(counter);
        
        // Smart pager button visibility based on position
        const updateButtonVisibility = () => {
          const n = items.length;
          prev.style.display = (idx > 0) ? 'block' : 'none';
          next.style.display = (idx < n - 1) ? 'block' : 'none';
          counter.style.display = 'block';
        };

        // Ensure CSP handling for any videos inside
        try { ensureCspSafeVideos(group); } catch (_) {}

        // Initial layout - show first item and set up button visibility
        show(0);
      } catch (_) {}
    });
  }

  // Ensure any links we produce open in a new tab
  /** Ensure all anchors in an injected subtree open in a new tab. */
  function retargetLinks(root) {
    if (!root || !root.querySelectorAll) return;
    const links = root.querySelectorAll('a[href]');
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      try {
        link.setAttribute('target', '_blank');
        const rel = (link.getAttribute('rel') || '').toLowerCase();
        const parts = new Set(rel.split(/\s+/).filter(Boolean));
        parts.add('noopener');
        parts.add('noreferrer');
        link.setAttribute('rel', Array.from(parts).join(' '));
      } catch (_) {}
    }
  }

  /**
   * Expand Twitter t.co shortlinks inside a root element by resolving their
   * final URL via background fetch, then updating anchor href and text.
   */
  function expandTcoLinksIn(root) {
    if (!root || !root.querySelectorAll) return;
    const links = root.querySelectorAll('a[href]');
    links.forEach((a) => {
      try {
        const u = new URL(a.href, location.href);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        if (host !== 't.co') return;
        if (a.__edggTcoResolving) return;
        a.__edggTcoResolving = true;
        safeSendMessage({ type: 'bgFetch', url: a.href }, (res) => {
          try {
            const finalUrl = res && res.finalUrl ? String(res.finalUrl) : '';
            if (!finalUrl) return;
            a.href = finalUrl;
            const txt = (a.textContent || '').trim();
            if (/^https?:\/\/t\.co\//i.test(txt) || txt.length <= 24) {
              a.textContent = finalUrl;
            }
            a.setAttribute('target', '_blank');
            const rel = (a.getAttribute('rel') || '').toLowerCase();
            const parts = new Set(rel.split(/\s+/).filter(Boolean));
            parts.add('noopener');
            parts.add('noreferrer');
            a.setAttribute('rel', Array.from(parts).join(' '));
          } catch (_) {}
        });
      } catch (_) {}
    });
  }

})();
