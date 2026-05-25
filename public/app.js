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

function isRecording(status) {
  return String(status.rec || '').toLowerCase() === 'rec';
}

function batteryClass(pct) {
  const n = parseInt(pct, 10);
  if (isNaN(n)) return '';
  if (n <= 10) return 'critical';
  if (n <= 25) return 'low';
  return '';
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
  // ── Timecode & recording ──
  const tc   = s.tc   || s.timecode    || '—';
  const batt = s.battery_percent !== undefined
    ? `${s.battery_percent}%`
    : s.batt || '—';
  const battCls = batteryClass(s.battery_percent);

  // ── SD cards ──
  const sdAState  = s.sdcard_a_state    || '—';
  const sdARemain = s.sdcard_a_remaining || '—';
  const sdBState  = s.sdcard_b_state    || '—';
  const sdBRemain = s.sdcard_b_remaining || '—';

  // ── Exposure ──
  const iris   = s.iris_value   || s.iris   || '—';
  const gain   = s.isogain_value || s.gain_value || '—';
  const gainMode = s.isogain_mode || s.gain_mode || '';
  const shutter = s.shutter_value || '—';
  const shutMode = s.shutter_mode || '';
  const nd       = s.neutraldensity_value;
  const ndStr    = nd !== undefined ? `ND${nd}` : '—';

  // ── White balance ──
  const wbMode = s.wb_mode  || s.wbm  || '—';
  const wbK    = s.kelvinvalue || s.awb_kelvinvalue || s.wb_value || '';
  const wbStr  = wbK ? `${wbMode} ${wbK}K` : wbMode;

  // ── Focus / Zoom ──
  const afMode    = s.afmode || s.af_mode || '—';
  const zoomPos   = s.zoom_position !== undefined ? s.zoom_position : '—';
  const recFmt    = s.rec_fmt || '—';
  const fullAuto  = (s.fullauto || '').toLowerCase() === 'on';

  return `
    <!-- Status strip -->
    <div class="status-strip">
      <span class="rec-badge ${recording ? 'is-recording' : ''}">
        <span class="rec-dot"></span>
        ${recording ? 'REC' : 'STBY'}
      </span>
      <span class="tc-display">${tc}</span>
      <span class="battery-badge ${battCls}">
        ${batteryIcon(parseInt(s.battery_percent, 10))}
        ${batt}
      </span>
    </div>

    <!-- SD cards -->
    <div class="sdcard-row">
      <div class="sdcard-badge ${sdAState.toLowerCase().includes('rec') ? 'active-slot' : ''}">
        <div class="sd-label">Slot A</div>
        <div class="sd-remain">${sdARemain}</div>
      </div>
      <div class="sdcard-badge ${sdBState.toLowerCase().includes('rec') ? 'active-slot' : ''}">
        <div class="sd-label">Slot B</div>
        <div class="sd-remain">${sdBRemain}</div>
      </div>
    </div>

    <!-- Settings readout -->
    <div class="settings-grid">
      <div class="setting-cell">
        <div class="s-label">Iris</div>
        <div class="s-value">${iris}</div>
      </div>
      <div class="setting-cell">
        <div class="s-label">${gainMode === 'iso' ? 'ISO' : 'Gain'}</div>
        <div class="s-value">${gain}</div>
      </div>
      <div class="setting-cell">
        <div class="s-label">Shutter</div>
        <div class="s-value">${shutter}</div>
      </div>
      <div class="setting-cell">
        <div class="s-label">ND</div>
        <div class="s-value">${ndStr}</div>
      </div>
      <div class="setting-cell">
        <div class="s-label">WB</div>
        <div class="s-value" title="${wbStr}">${wbStr}</div>
      </div>
      <div class="setting-cell">
        <div class="s-label">Format</div>
        <div class="s-value">${recFmt}</div>
      </div>
      <div class="setting-cell">
        <div class="s-label">AF Mode</div>
        <div class="s-value">${afMode}</div>
      </div>
      <div class="setting-cell">
        <div class="s-label">Zoom</div>
        <div class="s-value">${zoomPos}</div>
      </div>
    </div>

    <!-- Controls -->
    <div class="controls-section">
      <!-- Record -->
      <div class="controls-row">
        <button class="btn btn-record ${recording ? 'is-recording' : ''}" data-cmd="rec?cmd=trig" data-camid="${camId}">
          ${recording ? '⏹ STOP' : '⏺ RECORD'}
        </button>
        <button class="btn btn-sm btn-outline" data-cmd="rec?cmd=slot" data-camid="${camId}" title="Switch SD slot">
          SD Slot
        </button>
      </div>

      <!-- Iris -->
      <div class="controls-row">
        <span class="ctrl-label">Iris</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="drivelens?iris=minus" data-camid="${camId}" title="Iris close">−</button>
          <button class="btn" data-cmd="drivelens?iris=plus"  data-camid="${camId}" title="Iris open">+</button>
        </div>
        <button class="btn btn-xs btn-outline" data-cmd="drivelens?ai=push" data-camid="${camId}">Auto</button>
      </div>

      <!-- Gain -->
      <div class="controls-row">
        <span class="ctrl-label">Gain</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="drivelens?gain=minus" data-camid="${camId}" title="Gain down">−</button>
          <button class="btn" data-cmd="drivelens?gain=plus"  data-camid="${camId}" title="Gain up">+</button>
        </div>
      </div>

      <!-- ND -->
      <div class="controls-row">
        <span class="ctrl-label">ND</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="drivelens?nd=down" data-camid="${camId}">−</button>
          <button class="btn" data-cmd="drivelens?nd=up"   data-camid="${camId}">+</button>
        </div>
      </div>

      <!-- Focus -->
      <div class="controls-row">
        <span class="ctrl-label">Focus</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="drivelens?fl=3" data-camid="${camId}" title="Focus near">Near</button>
          <button class="btn" data-cmd="drivelens?fl=-3" data-camid="${camId}" title="Focus far">Far</button>
        </div>
        <button class="btn btn-xs btn-outline" data-cmd="drivelens?sw=afmode" data-camid="${camId}" title="Toggle AF">AF</button>
        <button class="btn btn-xs btn-outline" data-cmd="drivelens?af=togglelock" data-camid="${camId}" title="AF lock">Lock</button>
      </div>

      <!-- Zoom -->
      <div class="controls-row">
        <span class="ctrl-label">Zoom</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="drivelens?zoom=wide"  data-camid="${camId}" title="Zoom out">W</button>
          <button class="btn" data-cmd="drivelens?zoom=tele"  data-camid="${camId}" title="Zoom in">T</button>
        </div>
      </div>

      <!-- WB -->
      <div class="controls-row">
        <span class="ctrl-label">WB</span>
        <button class="btn btn-xs btn-outline" data-cmd="cmdwb?awbhold=trig" data-camid="${camId}">AWB</button>
        <button class="btn btn-xs btn-outline" data-cmd="setprop?wbm=daylight"  data-camid="${camId}">Day</button>
        <button class="btn btn-xs btn-outline" data-cmd="setprop?wbm=tungsten"  data-camid="${camId}">Tung</button>
      </div>

      <!-- Full Auto -->
      <div class="controls-row">
        <span class="ctrl-label">Auto</span>
        <button class="btn btn-xs ${fullAuto ? 'btn-primary' : 'btn-outline'}"
                data-cmd="setprop?fullauto=${fullAuto ? 'off' : 'on'}"
                data-camid="${camId}">
          Full Auto ${fullAuto ? 'ON' : 'OFF'}
        </button>
      </div>

      <!-- Disconnect -->
      <div class="controls-row controls-row-disconnect">
        <button class="btn btn-disconnect" data-action="disconnect" data-camid="${camId}">
          Disconnect
        </button>
      </div>
    </div>
  `;
}

function batteryIcon(pct) {
  const fill = isNaN(pct) ? 0 : Math.round(pct / 25) * 25;
  const bars = Math.round(fill / 25);
  return `<svg width="16" height="10" viewBox="0 0 16 10" fill="none" stroke="currentColor" stroke-width="1.2">
    <rect x=".6" y=".6" width="12.8" height="8.8" rx="1.5"/>
    <path d="M13.4 3.5v3" stroke-width="1.5"/>
    ${bars >= 1 ? '<rect x="1.8" y="1.8" width="2.2" height="6.4" rx=".5" fill="currentColor" stroke="none"/>' : ''}
    ${bars >= 2 ? '<rect x="4.9" y="1.8" width="2.2" height="6.4" rx=".5" fill="currentColor" stroke="none"/>' : ''}
    ${bars >= 3 ? '<rect x="8.0" y="1.8" width="2.2" height="6.4" rx=".5" fill="currentColor" stroke="none"/>' : ''}
    ${bars >= 4 ? '<rect x="11.1" y="1.8" width="1.5" height="6.4" rx=".5" fill="currentColor" stroke="none"/>' : ''}
  </svg>`;
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
  // Populate every panel body immediately (shows Connect button for unconfigured slots)
  CAM_IDS.forEach((id) => renderCam(id));
  updateGridLayout();

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
