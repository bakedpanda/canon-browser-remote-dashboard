/**
 * Canon Control Dashboard – Frontend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

// ── Constants ────────────────────────────────────────────────
const CAM_IDS = ['cam1', 'cam2', 'cam3', 'cam4'];
const STORAGE_KEY = 'canon_dashboard_v2';

const CAM_DEFAULTS = {
  cam1: { label: 'Camera 1', ip: '', username: 'Full', password: '12345678', protocol: 'browserremote' },
  cam2: { label: 'Camera 2', ip: '', username: 'Full', password: '12345678', protocol: 'browserremote' },
  cam3: { label: 'Camera 3', ip: '', username: 'Full', password: '12345678', protocol: 'browserremote' },
  cam4: { label: 'Camera 4', ip: '', username: 'Full', password: '12345678', protocol: 'browserremote' },
};

// ── State ────────────────────────────────────────────────────
const state = {
  cameras: {},
  ws: null,
  wsReconnectTimer: null,
};

// ── Persistence ──────────────────────────────────────────────
function loadConfigs() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch { return {}; }
}
function saveConfig(camId, cfg) {
  const all = loadConfigs(); all[camId] = cfg;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}
function deleteConfig(camId) {
  const all = loadConfigs(); delete all[camId];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

// ── WebSocket ────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => clearTimeout(state.wsReconnectTimer));

  ws.addEventListener('message', evt => {
    try { handleWSMessage(JSON.parse(evt.data)); } catch (_) {}
  });

  ws.addEventListener('close', () => {
    state.wsReconnectTimer = setTimeout(connectWS, 3000);
  });

  ws.addEventListener('error', () => ws.close());
}

function handleWSMessage(msg) {
  if (msg.type === 'status') {
    const cam = state.cameras[msg.camId];
    if (!cam) return;
    cam.connected = msg.connected;
    cam.status    = msg.status || {};
    if (msg.label) cam.config.label = msg.label;
    renderCam(msg.camId);
    updateHeaderIndicators();
  } else if (msg.type === 'disconnected') {
    const cam = state.cameras[msg.camId];
    if (!cam) return;
    cam.connected = false;
    cam.status    = {};
    renderCam(msg.camId);
    updateHeaderIndicators();
  }
}

// ── API ──────────────────────────────────────────────────────
async function apiConnect(camId, config) {
  return (await fetch('/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ camId, ...config }),
  })).json();
}

async function apiDisconnect(camId) {
  return (await fetch('/api/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ camId }),
  })).json();
}

async function apiCommand(camId, cmd) {
  return (await fetch('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ camId, cmd }),
  })).json();
}

// ── Status helpers ───────────────────────────────────────────
/** Resolve a value from the status object, trying multiple key names */
function v(s, ...keys) {
  for (const k of keys) {
    const val = s[k];
    if (val !== undefined && val !== null && val !== '') return String(val);
  }
  return '—';
}

function isRecording(status) {
  const r = v(status, 'rec', 'Rec', 'record', 'Record').toLowerCase();
  return r === 'rec' || r === 'recording';
}

/** Returns true if a mode string indicates an "auto" / "active" state */
function isAuto(modeStr) {
  if (!modeStr || modeStr === '—') return false;
  const m = modeStr.toLowerCase();
  return m.includes('auto') || m.includes('on') || m.includes('continuous')
      || m.includes('awb') || m.includes('lock') || m === 'true';
}

function parseRemainingToMinutes(str) {
  if (!str || str === '—') return Infinity;
  const parts = str.split(':').map(Number);
  if (parts.some(isNaN)) return Infinity;
  if (parts.length === 3) return parts[0] * 60 + parts[1];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Infinity;
}

function remainClass(str) {
  const m = parseRemainingToMinutes(str);
  if (m <= 10) return 'remain-critical';
  if (m <= 30) return 'remain-warning';
  return '';
}

// ── Header indicators ────────────────────────────────────────
function updateHeaderIndicators() {
  const el = document.getElementById('cam-rec-indicators');
  if (!el) return;
  el.innerHTML = CAM_IDS.map(camId => {
    const cam = state.cameras[camId];
    if (!cam || !cam.config.ip) return '';
    const rec  = cam.connected && isRecording(cam.status);
    const live = cam.connected && !rec;
    const cls  = rec ? 'hdr-rec' : live ? 'hdr-live' : 'hdr-off';

    // Remaining time for header chip
    const sdAs = v(cam.status, 'sdcard_a_state', 'sdA_state').toLowerCase();
    const sdBs = v(cam.status, 'sdcard_b_state', 'sdB_state').toLowerCase();
    const aRemain = v(cam.status, 'sdcard_a_remaining', 'sdA_remain');
    const bRemain = v(cam.status, 'sdcard_b_remaining', 'sdB_remain');
    const activeRemain = sdAs.includes('rec') ? aRemain : sdBs.includes('rec') ? bRemain : '—';
    const remStr = (rec && activeRemain !== '—') ? `<span class="hdr-remain ${remainClass(activeRemain)}">${activeRemain}</span>` : '';

    return `<div class="hdr-cam ${cls}">
      <span class="hdr-dot"></span>
      <div class="hdr-info">
        <span class="hdr-label">${cam.config.label}</span>
        <span class="hdr-status">${rec ? 'REC' : live ? 'LIVE' : 'OFF'}${remStr}</span>
      </div>
    </div>`;
  }).join('');
}

// ── Panel rendering ──────────────────────────────────────────
function getPanel(camId) { return document.getElementById(`panel-${camId}`); }

function renderCam(camId) {
  const cam   = state.cameras[camId];
  const panel = getPanel(camId);
  if (!panel || !cam) return;

  const { config, connected, status } = cam;
  const recording = connected && isRecording(status);

  panel.classList.toggle('is-recording',    recording);
  panel.classList.toggle('is-disconnected', !connected);

  panel.querySelector('.cam-name').textContent = config.label || camId;
  panel.querySelector('.cam-ip').textContent   = config.ip   || '—';

  const dot = panel.querySelector('.status-dot');
  dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;

  const body = panel.querySelector('.cam-body');
  if (!connected) {
    body.innerHTML = disconnectedHTML(config, camId);
  } else {
    body.innerHTML = connectedHTML(camId, status, recording, config);
  }
  attachBodyListeners(camId, panel);
}

function disconnectedHTML(config, camId) {
  const msg = config.ip ? `Not connected · ${config.ip}` : 'No camera configured';
  return `<div class="cam-placeholder">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="12" cy="12" r="3"/>
      <path d="M4 8l2-2h12l2 2v8l-2 2H6l-2-2V8z"/>
      <line x1="3" y1="3" x2="21" y2="21" stroke-width="1.5"/>
    </svg>
    <p>${msg}</p>
    <button class="btn btn-primary btn-connect-panel" data-action="connect" data-camid="${camId}">Connect</button>
  </div>`;
}

function connectedHTML(camId, s, recording, config) {
  // ── Resolve status values ──
  const tc       = v(s, 'tc', 'TC', 'timecode');
  const tcSub    = v(s, 'tc2', 'TC2', 'ltc');   // secondary TC if present

  const battPct  = s.battery_percent ?? s.batteryPercent ?? null;
  const battStr  = battPct !== null ? `${battPct}%` : v(s, 'batt', 'battery');
  const battRem  = v(s, 'battery_remaining', 'battRemain', 'batt_remain');
  const dcIn     = v(s, 'dc_in', 'dcin', 'power_source', 'PowerSource');
  const isDC     = dcIn !== '—' && (dcIn.toLowerCase().includes('dc') || dcIn.toLowerCase() === 'on');
  const camId_hw = v(s, 'camid', 'CamId', 'camera_id');
  const recFmt   = v(s, 'rec_fmt', 'recfmt', 'RecFormat', 'format');
  const zoomPos  = v(s, 'zoom_position', 'ZoomPos', 'zoom');
  const fullAuto = v(s, 'fullauto', 'FullAuto').toLowerCase() === 'on';
  const shutterV = v(s, 'shutter_value', 'ssv', 'Shutter');

  const sdAState  = v(s, 'sdcard_a_state',    'sdA_state',  'SlotAState');
  const sdARemain = v(s, 'sdcard_a_remaining', 'sdA_remain', 'SlotARemain');
  const sdBState  = v(s, 'sdcard_b_state',    'sdB_state',  'SlotBState');
  const sdBRemain = v(s, 'sdcard_b_remaining', 'sdB_remain', 'SlotBRemain');
  const sdAActive = sdAState.toLowerCase().includes('rec');
  const sdBActive = sdBState.toLowerCase().includes('rec');

  const activeRemain = sdAActive ? sdARemain : sdBActive ? sdBRemain
                     : sdARemain !== '—' ? sdARemain : sdBRemain;
  const rCls = remainClass(activeRemain);

  // ── Exposure ──
  const irisV    = v(s, 'iris_value',    'iris', 'av', 'Iris');
  const irisMode = v(s, 'iris_mode',     'am',   'IrisMode');
  const autoIris = isAuto(irisMode) || irisMode.includes('auto');

  const gainV    = v(s, 'isogain_value', 'gain_value', 'gcv', 'Gain');
  const gainMode = v(s, 'isogain_mode',  'gain_mode',  'gcm');
  const gainLbl  = gainMode.toLowerCase() === 'iso' ? 'ISO' : 'Gain';
  const autoGain = isAuto(gainMode);

  const ndV      = s.neutraldensity_value ?? s.nd_value ?? s.nd ?? null;
  const ndStr    = ndV !== null ? `ND ${ndV}` : '—';

  const wbMode   = v(s, 'wb_mode', 'wbm', 'WhiteBalance');
  const wbK      = v(s, 'kelvinvalue', 'awb_kelvinvalue', 'wb_value', 'wbv');
  const wbVal    = wbK !== '—' ? `${wbK}K` : wbMode;
  const autoWB   = wbMode.toLowerCase().includes('auto') || wbMode.toLowerCase() === 'awb';

  // ── Focus / AF ──
  const afMode    = v(s, 'afmode', 'af_mode', 'afm', 'AF');
  const afActive  = afMode !== '—' && !afMode.toLowerCase().includes('manual') && !afMode.toLowerCase().includes('off') && afMode !== '—';
  const afLockV   = v(s, 'af_lock', 'aflock', 'AfLock');
  const afLocked  = afLockV !== '—' && afLockV.toLowerCase() === 'lock';
  const faceDetV  = v(s, 'facedetection', 'face_detect', 'fdat', 'FaceDetect');
  const faceOn    = faceDetV !== '—' && (faceDetV.toLowerCase() === 'on' || faceDetV.toLowerCase() === 'true');

  // ── Camera info items ──
  const infoItems = [];
  if (battStr !== '—') {
    let battLine = `Battery: ${battStr}`;
    if (battRem !== '—') battLine += ` (${battRem})`;
    infoItems.push(battLine);
  }
  if (isDC) infoItems.push('Power: DC IN');
  else if (battStr !== '—') infoItems.push('Power: Battery');
  if (recFmt   !== '—') infoItems.push(`Format: ${recFmt}`);
  if (shutterV !== '—') infoItems.push(`Shutter: ${shutterV}`);
  if (zoomPos  !== '—') infoItems.push(`Zoom: ${zoomPos}`);
  if (camId_hw !== '—') infoItems.push(`ID: ${camId_hw}`);
  if (fullAuto)          infoItems.push('Full Auto: ON');

  const infoHTML = infoItems.length
    ? infoItems.map(i => `<div class="info-line">${i}</div>`).join('')
    : '<div class="info-line info-dim">No data yet</div>';

  // ── Toggle helper ──
  const tog = (active, label, cmd) =>
    `<button class="btn btn-xs btn-toggle${active ? ' is-active' : ''}" data-cmd="${cmd}" data-camid="${camId}">${label}</button>`;

  return `
  <div class="cam-layout">

    <!-- ════ LEFT COLUMN ════ -->
    <div class="cam-col-left">

      <!-- REC + TC / Remaining -->
      <div class="rec-tc-block">
        <button class="btn-rec-big${recording ? ' is-recording' : ''}" data-cmd="rec?cmd=trig" data-camid="${camId}">
          <span class="rec-big-dot"></span>
          REC
        </button>
        <div class="tc-remain-block">
          <div class="tc-primary">${tc}</div>
          ${tcSub !== '—' ? `<div class="tc-secondary">${tcSub}</div>` : ''}
          <div class="remain-header">Total Time Remaining</div>
          <div class="slot-list">
            <div class="slot-row${sdAActive ? ' slot-active' : ''}">
              <span class="slot-lbl">Card A</span>
              <span class="slot-time">${sdARemain}</span>
            </div>
            <div class="slot-row${sdBActive ? ' slot-active' : ''}">
              <span class="slot-lbl">Card B</span>
              <span class="slot-time">${sdBRemain}</span>
            </div>
            ${recording && activeRemain !== '—'
              ? `<div class="remain-countdown ${rCls}">${activeRemain} remaining</div>` : ''}
          </div>
          <button class="btn btn-xs btn-outline" data-cmd="rec?cmd=slot" data-camid="${camId}">SLOT SELECT</button>
        </div>
      </div>

      <!-- Focus row -->
      <div class="ctrl-line">
        <span class="cl">Focus</span>
        <button class="btn btn-xs" data-cmd="drivelens?fl=3"  data-camid="${camId}">N</button>
        <button class="btn btn-xs" data-cmd="drivelens?fl=-3" data-camid="${camId}">F</button>
        ${tog(afActive,  'AF',   'drivelens?sw=afmode')}
        ${tog(afLocked,  'LOCK', 'drivelens?af=togglelock')}
        ${tog(faceOn,    'FACE', `setprop?fdat=${faceOn ? 'off' : 'on'}`)}
      </div>

      <!-- Zoom row -->
      <div class="ctrl-line">
        <span class="cl">Zoom</span>
        <button class="btn btn-xs" data-cmd="drivelens?zoom=wide" data-camid="${camId}">−</button>
        <button class="btn btn-xs" data-cmd="drivelens?zoom=tele" data-camid="${camId}">+</button>
      </div>

      <!-- Camera info box -->
      <div class="cam-info-box">
        <div class="cam-info-title">Camera Info</div>
        ${infoHTML}
      </div>

    </div><!-- /cam-col-left -->

    <!-- ════ RIGHT COLUMN ════ -->
    <div class="cam-col-right">

      <!-- Iris -->
      <div class="exp-row">
        <span class="exp-lbl">Iris</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="drivelens?iris=minus" data-camid="${camId}">−</button>
          <button class="btn" data-cmd="drivelens?iris=plus"  data-camid="${camId}">+</button>
        </div>
        ${tog(autoIris, 'A', autoIris ? 'setprop?am=maniris' : 'setprop?am=autoiris')}
        <span class="exp-val">${irisV}</span>
      </div>

      <!-- Gain -->
      <div class="exp-row">
        <span class="exp-lbl">${gainLbl}</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="drivelens?gain=minus" data-camid="${camId}">−</button>
          <button class="btn" data-cmd="drivelens?gain=plus"  data-camid="${camId}">+</button>
        </div>
        ${tog(autoGain, 'A', autoGain ? 'setprop?gcm=manual' : 'setprop?gcm=auto')}
        <span class="exp-val">${gainV}</span>
      </div>

      <!-- ND -->
      <div class="exp-row">
        <span class="exp-lbl">ND</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="drivelens?nd=down" data-camid="${camId}">−</button>
          <button class="btn" data-cmd="drivelens?nd=up"   data-camid="${camId}">+</button>
        </div>
        <span class="exp-val">${ndStr}</span>
      </div>

      <!-- WB -->
      <div class="exp-row">
        <span class="exp-lbl">WB</span>
        <div class="nudge-pair">
          <button class="btn" data-cmd="setprop?wbm=seta"     data-camid="${camId}">−</button>
          <button class="btn" data-cmd="setprop?wbm=setb"     data-camid="${camId}">+</button>
        </div>
        ${tog(autoWB, 'AWB', 'cmdwb?awbhold=trig')}
        <span class="exp-val">${wbVal}</span>
      </div>

      <!-- Full auto + disconnect -->
      <div class="right-footer">
        ${tog(fullAuto, `Full Auto ${fullAuto ? 'ON' : 'OFF'}`,
          `setprop?fullauto=${fullAuto ? 'off' : 'on'}`)}
        <span class="flex-1"></span>
        <button class="btn btn-xs btn-disconnect" data-action="disconnect" data-camid="${camId}">
          DISCONNECT
        </button>
      </div>

    </div><!-- /cam-col-right -->
  </div>`;
}

// ── Disconnect helper ────────────────────────────────────────
async function doDisconnect(camId) {
  await apiDisconnect(camId);
  state.cameras[camId].connected = false;
  state.cameras[camId].status    = {};
  state.cameras[camId].config.ip = '';
  deleteConfig(camId);
  updateGridLayout();
  renderCam(camId);
  updateHeaderIndicators();
}

// ── Listeners ────────────────────────────────────────────────
function attachBodyListeners(camId, panel) {
  panel.querySelectorAll('[data-cmd]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      apiCommand(el.dataset.camid, el.dataset.cmd).catch(console.error);
    });
  });
  panel.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      if (el.dataset.action === 'connect')    openModal(el.dataset.camid);
      if (el.dataset.action === 'disconnect') doDisconnect(el.dataset.camid).catch(console.error);
    });
  });
}

// ── Grid layout ──────────────────────────────────────────────
function updateGridLayout() {
  const n = CAM_IDS.filter(id => state.cameras[id]?.config?.ip).length;
  document.getElementById('camera-grid').setAttribute('data-active', n || 4);
}

// ── Panel shell ──────────────────────────────────────────────
function buildPanels() {
  const grid = document.getElementById('camera-grid');
  grid.innerHTML = '';
  CAM_IDS.forEach(camId => {
    const cfg   = state.cameras[camId]?.config || CAM_DEFAULTS[camId];
    const panel = document.createElement('div');
    panel.className = 'cam-panel is-disconnected';
    panel.id        = `panel-${camId}`;
    panel.innerHTML = `
      <div class="cam-header">
        <div>
          <div class="cam-name">${cfg.label}</div>
          <div class="cam-ip">${cfg.ip || 'Not configured'}</div>
        </div>
        <div class="cam-header-right">
          <span class="status-dot disconnected"></span>
          <button class="btn-icon btn-config" aria-label="Settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 2v2m0 16v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M2 12h2m16 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="cam-body"></div>`;
    grid.appendChild(panel);
    panel.querySelector('.btn-config').addEventListener('click', () => openModal(camId));
  });
}

// ── Modal ────────────────────────────────────────────────────
let _modalCamId = null;

function openModal(camId) {
  _modalCamId = camId;
  const cam = state.cameras[camId];
  const cfg = cam?.config || CAM_DEFAULTS[camId];
  document.getElementById('modal-title').textContent    = `Configure ${cfg.label}`;
  document.getElementById('form-camId').value           = camId;
  document.getElementById('form-label').value           = cfg.label    || '';
  document.getElementById('form-ip').value              = cfg.ip       || '';
  document.getElementById('form-username').value        = cfg.username || 'Full';
  document.getElementById('form-password').value        = cfg.password || '12345678';
  document.getElementById('form-protocol').value        = cfg.protocol || 'browserremote';
  document.getElementById('btn-disconnect-cam').style.display = cam?.connected ? '' : 'none';
  document.getElementById('modal-backdrop').removeAttribute('hidden');
  document.getElementById('form-ip').focus();
}

function closeModal() {
  document.getElementById('modal-backdrop').setAttribute('hidden', '');
  _modalCamId = null;
}

// ── Init ─────────────────────────────────────────────────────
function init() {
  const saved = loadConfigs();
  CAM_IDS.forEach(id => {
    state.cameras[id] = {
      config:    { ...CAM_DEFAULTS[id], ...(saved[id] || {}), id },
      connected: false,
      status:    {},
    };
  });

  buildPanels();
  CAM_IDS.forEach(id => renderCam(id));
  updateGridLayout();
  updateHeaderIndicators();

  // Modal
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  document.getElementById('camera-form').addEventListener('submit', async e => {
    e.preventDefault();
    const camId    = document.getElementById('form-camId').value;
    const label    = document.getElementById('form-label').value.trim() || `Camera ${camId.slice(-1)}`;
    const ip       = document.getElementById('form-ip').value.trim();
    const username = document.getElementById('form-username').value.trim() || 'Full';
    const password = document.getElementById('form-password').value;
    const protocol = document.getElementById('form-protocol').value;
    if (!ip) return;
    const config = { id: camId, label, ip, username, password, protocol };
    state.cameras[camId].config = config;
    saveConfig(camId, config);
    closeModal();
    updateGridLayout();
    renderCam(camId);
    const dot = document.querySelector(`#panel-${camId} .status-dot`);
    if (dot) dot.className = 'status-dot connecting';
    apiConnect(camId, config).catch(console.error);
  });

  document.getElementById('btn-disconnect-cam').addEventListener('click', async () => {
    const camId = _modalCamId;
    closeModal();
    if (camId) doDisconnect(camId).catch(console.error);
  });

  // REC ALL
  document.getElementById('btn-rec-all').addEventListener('click', () => {
    CAM_IDS.forEach(id => {
      if (state.cameras[id]?.connected)
        apiCommand(id, 'rec?cmd=trig').catch(console.error);
    });
  });

  // Layout toggle
  document.getElementById('btn-layout-toggle').addEventListener('click', () => {
    const grid  = document.getElementById('camera-grid');
    const cycle = ['1','2','3','4'];
    const cur   = grid.getAttribute('data-active');
    grid.setAttribute('data-active', cycle[(cycle.indexOf(cur) + 1) % cycle.length]);
  });

  connectWS();

  // Auto-reconnect saved cameras
  Object.entries(loadConfigs()).forEach(([camId, cfg]) => {
    if (cfg.ip) {
      const dot = document.querySelector(`#panel-${camId} .status-dot`);
      if (dot) dot.className = 'status-dot connecting';
      apiConnect(camId, cfg).catch(console.error);
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
