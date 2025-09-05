
const el = (id) => document.getElementById(id);

const keys = ["enableTweets","enableMedia","enableYouTube","enableTwitch","renderOnHover","enableHoverPreview"];

async function load() {
  const res = await chrome.runtime.sendMessage({ type: "getSettings" });
  if (res?.ok) {
    const s = res.settings;
    keys.forEach(k => { if (el(k)) el(k).checked = !!s[k]; });
  }
}

async function onToggle(k) {
  const settings = {};
  settings[k] = el(k).checked;
  await chrome.runtime.sendMessage({ type: "setSettings", settings });
}

keys.forEach(k => {
  document.addEventListener("change", (e) => {
    if (e.target && e.target.id === k) onToggle(k);
  });
});

load();
