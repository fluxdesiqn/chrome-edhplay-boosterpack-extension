import type { Rpc } from '@shared/bridge-contract';
import { handleRpc } from './rpc';
import { heartbeat, releaseAllForTab } from './lock';

// Content scripts may only read chrome.storage.session when this is set.
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

chrome.runtime.onMessage.addListener((msg: Rpc, sender, sendResponse) => {
  handleRpc(msg, sender).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err) }));
  return true; // async response
});

// Per-tab port: used for lock heartbeats and to notice tab closure.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'hok-tab') return;
  const tabId = port.sender?.tab?.id ?? -1;
  port.onMessage.addListener((m: { hb?: string }) => {
    if (m.hb) port.postMessage({ hb: m.hb, ok: heartbeat(m.hb, tabId) });
  });
  port.onDisconnect.addListener(() => releaseAllForTab(tabId));
});

// Keyboard commands are forwarded to the active edhplay tab's content script.
chrome.commands.onCommand.addListener(async (command) => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: 'https://edhplay.com/*' });
  const tab = tabs[0];
  if (tab?.id != null) void chrome.tabs.sendMessage(tab.id, { hokCommand: command }).catch(() => undefined);
});

// Garbage-collect old mirrored room state (24 h).
chrome.runtime.onStartup.addListener(async () => {
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const stale = Object.entries(all)
    .filter(([k, v]) => k.startsWith('hok:room:') && (v as { updatedAt?: number })?.updatedAt !== undefined && (v as { updatedAt: number }).updatedAt < cutoff)
    .map(([k]) => k);
  if (stale.length) await chrome.storage.local.remove(stale);
});
