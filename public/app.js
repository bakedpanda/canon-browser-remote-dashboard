/**
 * Canon Remote Dashboard – Frontend Application
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

'use strict';

// ── Constants ────────────────────────────────────────────────
const CAM_IDS = ['cam1', 'cam2', 'cam3', 'cam4'];

const CAM_DEFAULTS = {
  cam1: { label: 'Camera 1', username: 'Full', password: '12345678', ip: '' },
  cam2: { label: 'Camera 2', username: 'Full', password: '12345678', ip: '' },
  cam3: { label: 'Camera 3', username: 'Full', password: '12345678', ip: '' },
  cam4: { label: 'Camera 4', username: 'Full', password: '12345678', ip: '' },
};

const STORAGE_KEY = 'canon_dashboard_cameras';

// ── State ────────────────────────────────────────────────────
const state = {
  cameras: {}, // camId → { config, connected, status }
  ws: null,
  wsReconnectTimer: null,
};

// ── Persistence ──────────────────────────────────────────────
function loadConfigs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveConfig(camId, config) {
  const all = loadConfigs();
  all[camId] = config;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

function deleteConfig(camId) {
  const all = loadConfigs();
  delete all[camId];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

// ── WebSocket ────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    console.log('WS connected');
    clearTimeout(state.wsReconnectTimer);
  });

  ws.addEventListener('message', (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleWSMessage(msg);
    } catch (e) {
      console.warn('WS parse error', e);
    }
  });

  ws.addEventListener('close', () => {
    console.log('WS closed – reconnecting in 3 s');
    state.wsReconnectTimer = setTimeout(connectWS, 3000);
  });

  ws.addEventListener('error', () => ws.close());
}

function sendWS(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function handleWSMessage(msg) {
  if (msg.type === 'status') {
    const cam = state.cameras[msg.camId];
    if (!cam) return;
    cam.connected = msg.connected;
    cam.status    = msg.status || {};
    if (msg.label) cam.config.label = msg.label;
    renderCam(msg.camId);
  } else if (msg.type === 'disconnected') {
    const cam = state.cameras[msg.camId];
    if (!cam) return;
    cam.connected = false;
    cam.status = {};
    renderCam(msg.camId);
  } else if (msg.type === 'error') {
    console.warn(`Camera error [${msg.camId}]:`, msg.error);
  }
}

// ── API calls ────────────────────────────────────────────────
async function apiConnect(camId, config) {
  const res = await fetch('/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ camId, ...config }),
  });
  return res.json();
}

async function apiDisconnect(camId) {
  const res = await fetch('/api/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ camId }),
  });
  return res.json();
}

async function apiCommand(camId, cmd) {
  const res = await fetch('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ camId, cmd }),
  });
  return res.json();
}

// ── Camera panel rendering ───────────────────────────────────

function getPanel(camId) {
  return document.getElementById(`panel-${camId}`);
}

// Resolve a value from a status object trying multiple possible key names
function val(s, ...keys) {
  for (const k of keys) {
    const v = s[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return '—';
}

function isRecording(status) {
  const r = val(status, 'rec', 'Rec', 'record', 'Record', 'r').toLowerCase();
  return r === 'rec' || r === 'recording' || r === 'true';
}

// Parse "H:MM:SS" or "H:MM" → total minutes. Returns Infinity if unparseable.
function parseRemainingToMinutes(str) {
  if (!str || str === '—') return Infinity;
  const parts = str.split(':').map(Number);
  if (parts.some(isNaN)) return Infinity;
  if (parts.length === 3) return parts[0] * 60 + parts[1];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Infinity;
}

function batteryClass(pct) {
  const n = parseInt(pct, 10);
  if (isNaN(n)) return '';
  if (n <= 10) return 'batt-critical';
  if (n <= 25) return 'batt-low';
  return '';
}

function updateHeaderIndicators() {
  const el = document.getElementById('cam-rec-indicators');
  if (!el) return;
  el.innerHTML = CAM_IDS.map((camId) => {
    const cam = state.cameras[camId];
    if (!cam || !cam.config.ip) return '';
    const rec  = cam.connected && isRecording(cam.status);
    const live = cam.connected && !rec;
    const cls  = rec ? 'hdr-rec' : live ? 'hdr-live' : 'hdr-off';
    return `<div class="hdr-cam ${cls}">
      <span class="hdr-dot"></span>
      <span class="hdr-label">${cam.config.label}</span>
    </div>`;
  }).join('');
}

function renderCam(camId) {
  const cam    = state.cameras[camId];
  const panel  = getPanel(camId);
  if (!panel) return;

  const { config, connected, status } = cam;
  const recording = connected && isRecording(status);

  panel.classList.toggle('is-recording',   recording);
  panel.classList.toggle('is-disconnected', !connected);

  // Header
  panel.querySelector('.cam-name').textContent = config.label || camId;
  panel.querySelector('.cam-ip').textContent   = config.ip   || '—';

  const dot = panel.querySelector('.status-dot');
  dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;

  // Body
  const body = panel.querySelector('.cam-body');
  if (!connected) {
    body.innerHTML = disconnectedHTML(config, camId);
    attachBodyListeners(camId, panel);
    return;
  }

  body.innerHTML = connectedHTML(camId, status, recording, config);
  attachBodyListeners(camId, panel);
  updateHeaderIndicators();
}

function disconnectedHTML(config, camId) {
  const msg = config.ip ? `Not connected · ${config.ip}` : 'No camera configured';
  return `
    <div class="cam-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="3"/>
        <path d="M4 8l2-2h12l2 2v8l-2 2H6l-2-2V8z"/>
        <line x1="3" y1="3" x2="21" y2="21" stroke-width="1.5"/>
      </svg>
      <p>${msg}</p>
      <button class="btn btn-primary btn-connect-panel" data-action="connect" data-camid="${camId}">
        Connect
      </button>
    </div>`;
}

function connectedHTML(camId, s, recording, config) {
  // ── Resolve status values (tries multiple key names across firmware versions) ──
  const tc       = val(s, 'tc', 'TC', 'timecode', 'TimeCode');
  const battPct  = s.battery_percent ?? s.batteryPercent ?? null;
  const battStr  = battPct !== null ? `${battPct}%` : val(s, 'batt', 'battery', 'Battery');
  const battCls  = batteryClass(battPct);

  const iris     = val(s, 'iris_value', 'iris', 'av', 'Iris');
  const gainLbl  = val(s, 'isogain_mode', 'gain_mode', 'gcm').toLowerCase() === 'iso' ? 'ISO' : 'Gain';
  const gain     = val(s, 'isogain_value', 'gain_value', 'gcv', 'Gain');
  const shutter  = val(s, 'shutter_value', 'ssv', 'Shutter');
  const ndRaw    = s.neutraldensity_value ?? s.nd_value ?? s.nd ?? null;
  const nd       = ndRaw !== null ? `ND${ndRaw}` : '—';
  const wbMode   = val(s, 'wb_mode', 'wbm', 'WhiteBalance');
  const wbK      = val(s, 'kelvinvalue', 'awb_kelvinvalue', 'wb_value', 'wbv', 'Kelvin');
  const wbStr    = wbK !== '—' ? `${wbMode} ${wbK}K` : wbMode;
  const afMode   = val(s, 'afmode', 'af_mode', 'afm', 'AF');
  const fullAuto = val(s, 'fullauto', 'FullAuto').toLowerCase() === 'on';
  const recFmt   = val(s, 'rec_fmt', 'recfmt', 'RecFormat', 'format');

  const sdAState  = val(s, 'sdcard_a_state',     'sdA_state',  'SlotAState');
  const sdARemain = val(s, 'sdcard_a_remaining',  'sdA_remain', 'SlotARemain');
  const sdBState  = val(s, 'sdcard_b_state',     'sdB_state',  'SlotBState');
  const sdBRemain = val(s, 'sdcard_b_remaining',  'sdB_remain', 'SlotBRemain');
  const sdAActive = sdAState.toLowerCase().includes('rec');
  const sdBActive = sdBState.toLowerCase().includes('rec');

  // Record time remaining (active slot when recording, otherwise show both)
  const activeRemain = sdAActive ? sdARemain : sdBActive ? sdBRemain
                     : sdARemain !== '—' ? sdARemain : sdBRemain;
  const remainMins   = parseRemainingToMinutes(activeRemain);
  const remainCls    = remainMins <= 10 ? 'remain-critical'
                     : remainMins <= 30 ? 'remain-warning' : '';

  return `
    <!-- ── Recording strip (full-width, red when rolling) ── -->
    <div class="rec-strip ${recording ? 'is-recording' : ''}">
      <div class="rec-strip-left">
        <span class="rec-dot-el"></span>
        <span class="rec-strip-lbl">${recording ? 'REC' : 'STBY'}</span>
        <span class="rec-tc">${tc}</span>
      </div>
      <div class="rec-strip-right">
        <span class="${battCls}">${battStr}</span>
        ${recFmt !== '—' ? `<span class="rec-fmt">${recFmt}</span>` : ''}
      </div>
    </div>

    <!-- ── Compact control grid (value shown inline with buttons) ── -->
    <div class="ctrl-grid">

      <div class="ctrl-row">
        <span class="cl">Iris</span>
        <span class="cv">${iris}</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="drivelens?iris=minus" data-camid="${camId}">−</button>
          <button class="btn" data-cmd="drivelens?iris=plus"  data-camid="${camId}">+</button>
        </div>
        <button class="btn btn-xs btn-outline" data-cmd="drivelens?ai=push" data-camid="${camId}">Auto</button>
        <span class="cs"></span>
        <span class="cl">${gainLbl}</span>
        <span class="cv">${gain}</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="drivelens?gain=minus" data-camid="${camId}">−</button>
          <button class="btn" data-cmd="drivelens?gain=plus"  data-camid="${camId}">+</button>
        </div>
      </div>

      <div class="ctrl-row">
        <span class="cl">ND</span>
        <span class="cv">${nd}</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="drivelens?nd=down" data-camid="${camId}">−</button>
          <button class="btn" data-cmd="drivelens?nd=up"   data-camid="${camId}">+</button>
        </div>
        <span class="cs"></span>
        <span class="cl">Shut</span>
        <span class="cv">${shutter}</span>
      </div>

      <div class="ctrl-row">
        <span class="cl">WB</span>
        <span class="cv wb-val">${wbStr}</span>
        <button class="btn btn-xs btn-outline" data-cmd="cmdwb?awbhold=trig"     data-camid="${camId}">AWB</button>
        <button class="btn btn-xs btn-outline" data-cmd="setprop?wbm=daylight"   data-camid="${camId}">Day</button>
        <button class="btn btn-xs btn-outline" data-cmd="setprop?wbm=tungsten"   data-camid="${camId}">Tung</button>
      </div>

      <div class="ctrl-row">
        <span class="cl">Focus</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="drivelens?fl=3"  data-camid="${camId}">N</button>
          <button class="btn" data-cmd="drivelens?fl=-3" data-camid="${camId}">F</button>
        </div>
        <span class="cl af-cl">${afMode}</span>
        <button class="btn btn-xs btn-outline" data-cmd="drivelens?sw=afmode"     data-camid="${camId}">AF</button>
        <button class="btn btn-xs btn-outline" data-cmd="drivelens?af=togglelock" data-camid="${camId}">Lock</button>
        <span class="cs"></span>
        <span class="cl">Zoom</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="drivelens?zoom=wide" data-camid="${camId}">W</button>
          <button class="btn" data-cmd="drivelens?zoom=tele" data-camid="${camId}">T</button>
        </div>
      </div>

      <!-- Record row -->
      <div class="ctrl-row rec-row">
        <button class="btn btn-record ${recording ? 'is-recording' : ''}" data-cmd="rec?cmd=trig" data-camid="${camId}">
          <span class="rec-btn-dot"></span> REC
        </button>
        ${activeRemain !== '—' ? `<span class="remain-time ${remainCls}">${activeRemain}</span>` : ''}
        <span class="cs"></span>
        <span class="cl">SD</span>
        <span class="cv sd-val ${sdAActive ? 'sd-active' : ''}">A ${sdARemain}</span>
        <span class="cv sd-val ${sdBActive ? 'sd-active' : ''}">B ${sdBRemain}</span>
        <button class="btn btn-xs btn-outline" data-cmd="rec?cmd=slot" data-camid="${camId}">Swap</button>
      </div>

      <!-- Bottom row -->
      <div class="ctrl-row bottom-row">
        <button class="btn btn-xs ${fullAuto ? 'btn-primary' : 'btn-outline'}"
                data-cmd="setprop?fullauto=${fullAuto ? 'off' : 'on'}" data-camid="${camId}">
          Full Auto ${fullAuto ? 'ON' : 'OFF'}
        </button>
        <span class="cs"></span>
        <button class="btn btn-xs btn-disconnect" data-action="disconnect" data-camid="${camId}">Disconnect</button>
      </div>

    </div>
  `;
}


// Shared disconnect logic used by both the modal and in-panel button
async function doDisconnect(camId) {
  await apiDisconnect(camId);
  state.cameras[camId].connected = false;
  state.cameras[camId].status    = {};
  state.cameras[camId].config.ip = '';
  deleteConfig(camId);
  updateGridLayout();
  renderCam(camId);
}

// Attach event listeners to dynamically rendered body controls
function attachBodyListeners(camId, panel) {
  panel.querySelectorAll('[data-cmd]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const cmd    = el.dataset.cmd;
      const target = el.dataset.camid;
      apiCommand(target, cmd).catch(console.error);
    });
  });

  panel.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = el.dataset.action;
      const target = el.dataset.camid;
      if (action === 'connect')    openModal(target);
      if (action === 'disconnect') doDisconnect(target).catch(console.error);
    });
  });
}

// ── Grid layout ──────────────────────────────────────────────
function updateGridLayout() {
  const connected = CAM_IDS.filter((id) => {
    const cam = state.cameras[id];
    return cam && cam.config.ip;
  });
  const grid = document.getElementById('camera-grid');
  grid.setAttribute('data-active', connected.length || 4);
}

// ── Build initial DOM panels ──────────────────────────────────
function buildPanels() {
  const grid = document.getElementById('camera-grid');
  grid.innerHTML = '';

  CAM_IDS.forEach((camId) => {
    const panel = document.createElement('div');
    panel.className   = 'cam-panel is-disconnected';
    panel.id          = `panel-${camId}`;
    panel.innerHTML   = panelShellHTML(camId);
    grid.appendChild(panel);

    // Config button (gear icon in header)
    panel.querySelector('.btn-config').addEventListener('click', () => openModal(camId));
  });
}

function panelShellHTML(camId) {
  const cfg = state.cameras[camId]?.config || CAM_DEFAULTS[camId];
  return `
    <div class="cam-header">
      <div>
        <div class="cam-name">${cfg.label}</div>
        <div class="cam-ip">${cfg.ip || 'Not configured'}</div>
      </div>
      <div class="cam-header-right">
        <span class="status-dot disconnected"></span>
        <button class="btn-icon btn-config" aria-label="Camera settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 2v2m0 16v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M2 12h2m16 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="cam-body"></div>
  `;
}

// ── Modal ────────────────────────────────────────────────────
let _modalCamId = null;

function openModal(camId) {
  _modalCamId = camId;
  const cam = state.cameras[camId];
  const cfg = cam?.config || CAM_DEFAULTS[camId];

  document.getElementById('modal-title').textContent = `Configure ${cfg.label}`;
  document.getElementById('form-camId').value    = camId;
  document.getElementById('form-label').value    = cfg.label || '';
  document.getElementById('form-ip').value       = cfg.ip   || '';
  document.getElementById('form-username').value = cfg.username || 'Full';
  document.getElementById('form-password').value = cfg.password || '12345678';

  const disconnectBtn = document.getElementById('btn-disconnect-cam');
  disconnectBtn.style.display = cam?.connected ? '' : 'none';

  document.getElementById('modal-backdrop').removeAttribute('hidden');
  document.getElementById('form-ip').focus();
}

function closeModal() {
  document.getElementById('modal-backdrop').setAttribute('hidden', '');
  _modalCamId = null;
}

// ── Init ─────────────────────────────────────────────────────
function init() {
  // Populate state from storage + defaults
  const saved = loadConfigs();
  CAM_IDS.forEach((id) => {
    const savedCfg = saved[id];
    state.cameras[id] = {
      config: { ...CAM_DEFAULTS[id], ...(savedCfg || {}), id },
      connected: false,
      status: {},
    };
  });

  buildPanels();
  CAM_IDS.forEach((id) => renderCam(id));
  updateGridLayout();
  updateHeaderIndicators();

  // Modal events
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  document.getElementById('camera-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const camId    = document.getElementById('form-camId').value;
    const label    = document.getElementById('form-label').value.trim() || `Camera ${camId.slice(-1)}`;
    const ip       = document.getElementById('form-ip').value.trim();
    const username = document.getElementById('form-username').value.trim() || 'Full';
    const password = document.getElementById('form-password').value;

    if (!ip) return;

    const config = { id: camId, label, ip, username, password };
    state.cameras[camId].config = config;
    saveConfig(camId, config);
    closeModal();
    updateGridLayout();
    renderCam(camId); // show connecting state

    // Set status dot to "connecting"
    const dot = document.querySelector(`#panel-${camId} .status-dot`);
    if (dot) dot.className = 'status-dot connecting';

    try {
      await apiConnect(camId, config);
    } catch (err) {
      console.error('Connect error:', err);
    }
  });

  document.getElementById('btn-disconnect-cam').addEventListener('click', async () => {
    const camId = _modalCamId;
    closeModal();
    if (!camId) return;
    doDisconnect(camId).catch(console.error);
  });

  // REC ALL — trigger record on every connected camera
  document.getElementById('btn-rec-all').addEventListener('click', () => {
    CAM_IDS.forEach((camId) => {
      const cam = state.cameras[camId];
      if (cam && cam.connected) {
        apiCommand(camId, 'rec?cmd=trig').catch(console.error);
      }
    });
  });

  // Layout toggle button
  document.getElementById('btn-layout-toggle').addEventListener('click', () => {
    const grid = document.getElementById('camera-grid');
    const cur  = grid.getAttribute('data-active');
    // Cycle through different active counts for preview
    const cycle = ['1', '2', '3', '4'];
    const idx   = cycle.indexOf(cur);
    grid.setAttribute('data-active', cycle[(idx + 1) % cycle.length]);
  });

  // Connect WebSocket
  connectWS();

  // Auto-connect saved cameras on load
  const savedAll = loadConfigs();
  Object.entries(savedAll).forEach(([camId, cfg]) => {
    if (cfg.ip) {
      const dot = document.querySelector(`#panel-${camId} .status-dot`);
      if (dot) dot.className = 'status-dot connecting';
      apiConnect(camId, cfg).catch(console.error);
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
