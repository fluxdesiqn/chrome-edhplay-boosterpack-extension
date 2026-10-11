/**
 * ISOLATED-world content script: hosts the panel UI, persists state, brokers
 * chrome.* APIs for the MAIN-world engine.
 */
import { render, h } from 'preact';
import { Bridge } from '@shared/bridge';
import type { IsoToMain, MainToIso } from '@shared/bridge-contract';
import type { Config, HokGameState } from '@shared/state';
import { defaultConfig } from '@shared/state';
import { Panel } from '@ui/Panel';
import { applyMainMessage, bridgeReady, config as configSig, readOnly, setList, setListError, setListLoader } from '@ui/machine';
import type { RuntimeSetData, SetSummary } from '@shared/packs/runtime';
import { registerSetInfo, registerSetName, setInfoFor } from '@shared/packs/types';
import { loadConfig, loadRoomState, saveConfig, saveRoomState } from './storage';
import { RoomLock, rpc } from './lock';
import cssText from '@ui/styles.css?inline';
import revealCss from '@ui/reveal.css?inline';
import componentsCss from '@ui/components.css?inline';
import { RevealHost } from '@ui/RevealHost';

const GAME_PATH = /^\/games\/([^/]+)\/(play|spectate)\/?$/;

let currentRoom: string | null = null;
let lastRecord: unknown[] = [];
let config: Config = defaultConfig;
const lock = new RoomLock((held) => {
  readOnly.value = !held;
  if (currentRoom) void hydrate(currentRoom);
});

const bridge = new Bridge<IsoToMain, MainToIso>({
  role: 'iso',
  onReady: () => {
    bridgeReady.value = true;
    void rpc({ m: 'ready' }).catch(() => undefined);
  },
  onMessage: (msg) => {
    applyMainMessage(msg);
    if (msg.type === 'socket') {
      sawSocket = true;
      if (msg.ev === 'opened' || msg.ev === 'confirmed') void onRoom(msg.ctx.roomId, msg.ctx.spectator);
    }
    if (msg.type === 'state' && currentRoom) void saveRoomState(currentRoom, msg.state);
    if (msg.type === 'record') lastRecord = msg.frames;
    if (msg.type === 'need-set') void answerNeedSet(msg.set);
    if (msg.type === 'need-prints') void answerNeedPrints(msg.cards);
  },
});

async function answerNeedSet(set: string): Promise<void> {
  try {
    const res = await rpc<{ data: RuntimeSetData | null; error?: string }>({ m: 'sets.cards', set });
    bridge.send({ type: 'set-data', set, data: res?.data ?? null, error: res?.error });
    if (res?.data) rememberRecentSet(set);
  } catch (err) {
    bridge.send({ type: 'set-data', set, data: null, error: String(err) });
  }
}

async function answerNeedPrints(cards: Array<{ scryfallId: string; name: string; set: string }>): Promise<void> {
  try {
    const entries = await rpc<Record<string, { card_print_id: string; card_id: string } | null>>({ m: 'prints.resolveCards', cards: cards.map((c) => ({ scryfallId: c.scryfallId, name: c.name })) });
    bridge.send({ type: 'prints', entries: entries ?? {} });
  } catch {
    /* identities stay synthetic */
  }
}

function rememberRecentSet(set: string): void {
  if (['chk', 'bok', 'sok', 'neo'].includes(set)) return;
  const recent = [set, ...config.recentSets.filter((s) => s !== set)].slice(0, 8);
  if (recent.join() === config.recentSets.join()) return;
  config = { ...config, recentSets: recent };
  configSig.value = config;
  void saveConfig(config);
  bridge.send({ type: 'cfg', config });
}

setListLoader.load = () => {
  setListError.value = undefined;
  rpc<{ sets: SetSummary[] }>({ m: 'sets.list' })
    .then((res) => {
      const sets = res?.sets ?? [];
      for (const s of sets) {
        registerSetName(s.code, s.name);
        registerSetInfo(s.code, setInfoFor(s.type, s.released));
      }
      setList.value = sets;
    })
    .catch((err) => {
      setListError.value = String(err);
      setList.value = [];
    });
};

async function onRoom(roomId: string, spectator: boolean): Promise<void> {
  if (roomId === currentRoom) return;
  currentRoom = roomId;
  if (!spectator) await lock.acquire(roomId);
  else readOnly.value = true;
  await hydrate(roomId);
  mountPanel();
}

async function hydrate(roomId: string): Promise<void> {
  const state: HokGameState | null = await loadRoomState(roomId);
  bridge.send({ type: 'hydrate', roomId, state, config, readOnly: readOnly.value });
}

async function init(): Promise<void> {
  config = await loadConfig();
  configSig.value = config;
  // Hydrate eagerly for the room in the URL so state is ready before the app connects.
  const m = GAME_PATH.exec(location.pathname);
  if (m?.[1]) {
    const state = await loadRoomState(m[1]);
    bridge.send({ type: 'hydrate', roomId: m[1], state, config, readOnly: false });
  }
  watchForLateLoad();
}

let sawSocket = false;
function watchForLateLoad(): void {
  // If the game table is on screen but the tap never reported a socket, the
  // page connected before the extension loaded (install/update mid-game).
  setTimeout(() => {
    if (!sawSocket && document.querySelector('.game-layout')) {
      applyMainMessage({ type: 'needs-reload' });
      mountPanel();
    }
  }, 8000);
}

let mounted = false;
function mountPanel(): void {
  if (mounted) return;
  mounted = true;
  const host = document.createElement('div');
  host.id = 'hok-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = cssText + '\n' + revealCss + '\n' + componentsCss;
  shadow.appendChild(style);
  const mount = document.createElement('div');
  shadow.appendChild(mount);
  // Keep the game's global key handler from seeing keystrokes typed into the panel.
  host.addEventListener('keydown', (e) => e.stopPropagation());
  host.addEventListener('keyup', (e) => e.stopPropagation());
  (document.body ?? document.documentElement).appendChild(host);

  const onConfig = (patch: Partial<Config>) => {
    config = { ...config, ...patch };
    configSig.value = config;
    void saveConfig(config);
    bridge.send({ type: 'cfg', config });
  };
  const onExportRecord = () => {
    bridge.send({ type: 'cmd', cmd: 'export-record' });
    setTimeout(() => {
      const blob = new Blob([lastRecord.map((f) => JSON.stringify(f)).join('\n')], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hok-record-${Date.now()}.jsonl`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 300);
  };
  render(h(Panel, { send: (m) => bridge.send(m), onConfig, onExportRecord }), mount);
  const revealMount = document.createElement('div');
  shadow.appendChild(revealMount);
  render(h(RevealHost, { send: (m) => bridge.send(m) }), revealMount);
}

// Keyboard commands relayed from the background worker.
chrome.runtime.onMessage.addListener((msg: { hokCommand?: string }) => {
  if (msg.hokCommand === 'toggle-panel') {
    config = { ...config, panelCollapsed: !config.panelCollapsed };
    configSig.value = config;
    void saveConfig(config);
    mountPanel();
  } else if (msg.hokCommand === 'open-activation') {
    bridge.send({ type: 'cmd', cmd: 'activate', set: config.defaultSet });
  }
});

// In-page fallback for the same chords (capture phase beats the game's handler).
window.addEventListener(
  'keydown',
  (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyK') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) bridge.send({ type: 'cmd', cmd: 'activate', set: config.defaultSet });
      else {
        config = { ...config, panelCollapsed: !config.panelCollapsed };
        configSig.value = config;
        void saveConfig(config);
        mountPanel();
      }
    }
  },
  true,
);

void init();
