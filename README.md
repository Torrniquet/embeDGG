
# embeDGG (MVP)

A Chrome MV3 extension that injects lightweight embeds under messages in **https://www.destiny.gg/embed/chat**.

## Features
- Real-time parsing of new chat messages; retroactive parsing when a message scrolls into view.
- **Tweets**: lightweight placeholder card for links from `Twitter/X/Nitter`, `Twitch`, `YouTube`, `Kick`, `Instagram` and numerous Image/Video hosting sites like `Imgur` (no widgets.js).
- **Media**: lazy-loaded `<img>` / `<video>` for direct file links on a **hardcoded whitelist** of domains.
- Settings sync via `chrome.storage.sync`; popup UI with real-time toggles.
- Injects directly beneath the message node. Width = message container width minus username gutter (best effort), max 566px.
- Only active on the embed chat page. Heuristic to skip if not logged-in.

## To Do
- Fix some YouTube embeds.
- Make links to Reddit posts (without file extension suffix) fetch/embed image/video + body text.
- Fix author fetch on some tweets (only shows tweet body/file uploads attached).
- Twitch stream links embedding x2 cards.
- Minor CSS enhancements.
- Add pagination to Tweet embeds with multiple file uploads.
- Cleanup any deprecated/redundant code.
- Not adding TikTok (Chinese spy operation).

## Install (Developer Mode)
1. Unzip this folder anywhere (suggested: `/Users/torrniquet/Development/Project/embeDGG`).
2. In Chrome: `chrome://extensions` → toggle **Developer mode**.
3. Click **Load unpacked** → select the folder.
4. Open https://www.destiny.gg/embed/chat and test.

## Notes / Roadmap
- **Tweet rendering** is a minimal placeholder in MVP. Next step: background fetch from `fxtwitter.com` (or similar) to hydrate tweet text and media (respecting the whitelist) and render without iframes.
- **Login detection** uses a heuristic; if you have a reliable DOM handle for "logged-in" state, we can wire that.
- **Security**: strict domain whitelist; no embedding from unknown hosts.


## Testing
1. Open https://www.destiny.gg/bigscreen or https://www.destiny.gg/embed/chat
2. Run the following code in the Google Chrome WebDev Tools console to see some examples of different types of embeds:

    function testEmbedLinks() {
        const exampleEmbedLinks = [
            'https://files.catbox.moe/d97241.mp4',
            'https://imgur.com/a/Vxl95hq',
            'https://x.com/TheOmniLiberal/status/1943717870245949733',
            'https://www.youtube.com/watch?v=fzVHs6XmK-E',
            'https://www.twitch.tv/xqc',
            'https://kick.com/xqc',
            'https://www.instagram.com/reels/DL7Hc8JuLuP',
        ];

        exampleEmbedLinks.forEach(linkUrl => {
            let msg = '<div class="msg-chat msg-user subscriber " data-username="embeDGG TEST MESSAGE" data-mentioned="routey">';
            msg += '<time class="time" title="" data-unixtimestamp="">00:00</time>';
            msg += '<span class="features">';
            msg += '<i data-flair="flair13" class="flair flair13" title="Subscriber Tier 1"></i> ';
            msg += '<i data-flair="subscriber" class="flair subscriber" title="Subscriber"></i> ';
            msg += '</span> <a title="" class="user">embeDGG TEST MESSAGE</a>';
            msg += '<span class="ctrl">: </span> ';
            msg += '<span class="text">';
            msg += '<a target="_blank"href="' + linkUrl + '">' + linkUrl + '</a>';
            msg += '</span>';
            msg += '</div>';

            jQuery('.chat-lines').append(msg);
        });
    };

    testEmbedLinks();