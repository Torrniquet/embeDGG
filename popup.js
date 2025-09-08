/**
 *  @file 66
 *
 * Tiny controller for the extension popup UI.
 *
 * The popup has a set of checkboxes for feature toggles. We read the current
 * values from the background script on open, and write back whenever a toggle
 * changes. The background will then broadcast the settings so content scripts
 * can pick them up for new messages.
 */

// Shorthand element getter by id.
const el = (id) => document.getElementById(id);

// List of setting keys mirrored to checkbox ids in popup.html.
const keys = [
  "enableTweets",
  "enableMedia",
  "enableYouTube",
  "enableTwitch",
  "enableKick",
  "enableInstagram",
  "blurMedia"
];

// Load current settings and reflect them in the popup controls.
async function load() {
  const res = await chrome.runtime.sendMessage({ type: "getSettings" });
  if (res?.ok) {
    const s = res.settings;
    keys.forEach(k => { if (el(k)) el(k).checked = !!s[k]; });
  }
}

// Persist a single setting change.
async function onToggle(k) {
  const settings = {};
  settings[k] = el(k).checked;
  await chrome.runtime.sendMessage({ type: "setSettings", settings });
}

// Wire up a single delegated change listener so we don't need one per control.
keys.forEach(k => {
  document.addEventListener("change", (e) => {
    if (e.target && e.target.id === k) onToggle(k);
  });
});

// Initialize on popup open.
load();
