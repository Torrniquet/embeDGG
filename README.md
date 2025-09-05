
# embeDGG (MVP)

A Chrome MV3 extension that injects lightweight embeds under messages in **https://www.destiny.gg/embed/chat**.

## Features
- Real-time parsing of new chat messages; retroactive parsing when a message scrolls into view.
- **Tweets**: lightweight placeholder card for `twitter.com`, `x.com`, `nitter.net`, `fxtwitter.com` links (no widgets.js).
- **Media**: lazy-loaded `<img>` / `<video>` for direct file links on a **hardcoded whitelist** of domains.
- Optional **YouTube** and **Twitch** embeds via lazy iframes (toggleable).
- Settings sync via `chrome.storage.sync`; popup UI with real-time toggles.
- Injects directly beneath the message node. Width = message container width minus username gutter (best effort), max 500px.
- Only active on the embed chat page. Heuristic to skip if not logged-in.

## Install (Developer Mode)
1. Unzip this folder anywhere (suggested: `/Users/torrniquet/Development/Project/embeDGG`).
2. In Chrome: `chrome://extensions` → toggle **Developer mode**.
3. Click **Load unpacked** → select the folder.
4. Open https://www.destiny.gg/embed/chat and test.

## Notes / Roadmap
- **Tweet rendering** is a minimal placeholder in MVP. Next step: background fetch from `fxtwitter.com` (or similar) to hydrate tweet text and media (respecting the whitelist) and render without iframes.
- **Login detection** uses a heuristic; if you have a reliable DOM handle for "logged-in" state, we can wire that.
- **Security**: strict domain whitelist; no embedding from unknown hosts.
