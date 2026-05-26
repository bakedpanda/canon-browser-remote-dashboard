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

  ws.addEventListener('open', async () => {
    clearTimeout(state.wsReconnectTimer);
    // Ask the server what cameras it already has connected.
    // Only call apiConnect for cameras the server doesn't have — this prevents
    // tearing down a working camera session on a simple page refresh.
    try {
      const srv = await fetch('/api/status').then(r => r.json()).catch(() => ({}));
      CAM_IDS.forEach(id => {
        const cam = state.cameras[id];
        const s   = srv[id];
        if (s?.connected) {
          // Server already has this camera connected — use its data immediately.
          cam.connected  = true;
          cam.connecting = false;
          cam.status     = s.status || {};
          if (s.label && s.label !== cam.config.label) cam.config.label = s.label;
          if (s.ip    && s.ip    !== cam.config.ip)    cam.config.ip    = s.ip;
        } else if (cam.config.ip && !cam.connected) {
          // Server doesn't have it — kick off connection (leaves connecting=true).
          apiConnect(id, cam.config).catch(console.error);
        }
      });
      CAM_IDS.forEach(id => renderCam(id));
      updateHeaderIndicators();
    } catch (_) {}
  });

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
    cam.connected  = msg.connected;
    cam.connecting = false;
    cam.status     = msg.status || {};
    // Restore config from server state on page refresh (covers cleared localStorage)
    if (msg.label) cam.config.label = msg.label;
    if (msg.ip)    cam.config.ip    = msg.ip;
    if (msg.ip && msg.connected) {
      // Re-persist so next refresh still has the config
      saveConfig(msg.camId, { ...cam.config });
    }
    updateGridLayout();
    renderCam(msg.camId);
    updateHeaderIndicators();
  } else if (msg.type === 'disconnected') {
    const cam = state.cameras[msg.camId];
    if (!cam) return;
    cam.connected  = false;
    cam.connecting = false;
    cam.status     = {};
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

// ── Canon status helpers ─────────────────────────────────────

/**
 * Recording states confirmed from Canon status.js cbFunc.rec handler.
 * Button changes to RecBTN for these values.
 */
const REC_STATES = new Set([
  'Rec', 'PreRecRec', 'FrmRecStby', 'FrmRec',
  'IntRecStby', 'IntRec', 'SFRec',
  'rec', 'sf_rec', 'frm_rec', 'int_rec', 'pre_rec_rec',
]);

function isRecording(status) {
  return REC_STATES.has(status?.rec);
}

/**
 * Format Canon timecode: 8-char string "HHMMSSFF" → "HH:MM:SS:FF"
 * The camera sends tc as e.g. "00003711" meaning 00:00:37:11
 */
function formatTC(tc) {
  if (!tc || tc === 'non') return '—';
  const s = String(tc).padStart(8, '0');
  return `${s.slice(0,2)}:${s.slice(2,4)}:${s.slice(4,6)}:${s.slice(6,8)}`;
}

/**
 * Format remaining time from integer minutes (as returned by camera rtime fields).
 * Returns '—' for null/undefined/negative values.
 */
function formatRemainMins(rtime) {
  if (rtime == null) return '—';
  const n = parseInt(rtime, 10);
  if (isNaN(n) || n < 0) return '—';
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/**
 * Format remaining time as raw integer minutes (e.g. "120 mins").
 * Used for card slot displays where the camera only gives integer minutes anyway.
 */
function formatRemainRaw(mins) {
  if (mins == null) return '—';
  const n = parseInt(mins, 10);
  if (isNaN(n) || n < 0) return '—';
  return `${n} mins`;
}

/** CSS class for low remaining time (minutes integer) */
function remainClassFromMins(mins) {
  if (mins == null || mins < 0) return '';
  const n = parseInt(mins, 10);
  if (isNaN(n)) return '';
  if (n <= 10) return 'remain-critical';
  if (n <= 30) return 'remain-warning';
  return '';
}

/** WB mode → human label */
const WB_LABELS = {
  awb: 'AWB', seta: 'Set A', setb: 'Set B',
  daylight: 'Daylight', tungsten: 'Tungsten', kelvin: 'Kelvin',
};

/**
 * Canon XF705 valid Kelvin values (from getprop?r=wbvk).
 * The camera silently ignores any value not in this list.
 * Nudge buttons step through adjacent entries.
 */
const KELVIN_STEPS = [
  2000,2020,2040,2060,2080,2110,2130,2150,2170,2200,2220,2250,2270,
  2300,2330,2350,2380,2410,2440,2470,2500,2530,2560,2600,2630,2670,
  2700,2740,2780,2820,2860,2900,2940,2990,3030,3080,3130,3200,3230,
  3280,3330,3390,3450,3510,3570,3640,3700,3770,3850,3920,4000,4080,
  4170,4300,4350,4440,4550,4650,4760,4880,5000,5130,5260,5410,5600,
  5710,5880,6060,6300,6450,6670,6900,7140,7410,7690,8000,8330,8700,
  9090,9520,10000,10530,11110,11760,12500,13330,14290,15000,
];

/** CC valid range: -20 to +20 in steps of 1 */
const CC_MIN = -20;
const CC_MAX = 20;

/** Dashboard WB presets — stored in localStorage, sent as raw K/CC values */
function getWbPreset(slot) {
  try { return JSON.parse(localStorage.getItem(`wb_preset_${slot}`)) || null; } catch { return null; }
}
function saveWbPreset(slot, k, cc) {
  localStorage.setItem(`wb_preset_${slot}`, JSON.stringify({ k, cc }));
}
function fmtWbPreset(preset) {
  if (!preset) return '—';
  const ccStr = preset.cc >= 0 ? `+${preset.cc}` : `${preset.cc}`;
  return `${preset.k}K ${ccStr}`;
}

/** Record format → human label */
const RECFMT_LABELS = {
  'xf-avc': 'XF-AVC', 'hevc': 'HEVC', 'mp4': 'MP4',
};

// ── REC ALL button state ─────────────────────────────────────
function updateRecAllButton() {
  const btn = document.getElementById('btn-rec-all');
  const lbl = btn?.querySelector('.rec-all-label');
  if (!btn || !lbl) return;
  const connected = CAM_IDS.filter(id => state.cameras[id]?.connected);
  const allRec    = connected.length > 0 &&
                    connected.every(id => isRecording(state.cameras[id].status));
  btn.classList.toggle('is-recording', allRec);
  lbl.textContent = allRec ? 'STOP ALL' : 'REC ALL';
}

// ── Header indicators ────────────────────────────────────────
function updateHeaderIndicators() {
  const el = document.getElementById('cam-rec-indicators');
  if (!el) return;
  el.innerHTML = CAM_IDS.map(camId => {
    const cam = state.cameras[camId];
    if (!cam || !cam.config.ip) return '';
    const s    = cam.status || {};
    const rec  = cam.connected && isRecording(s);
    const live = cam.connected && !rec;
    const cls  = rec ? 'hdr-rec' : live ? 'hdr-live' : 'hdr-off';

    // Active card remaining time
    const sdA = s.Omedia?.Osda;
    const sdB = s.Omedia?.Osdb;
    const sdAActive = sdA?.state !== 'n' && sdA?.state != null && sdA?.select === 1;
    const sdBActive = sdB?.state !== 'n' && sdB?.state != null && sdB?.select === 1;
    const activeRemainMins = sdAActive ? sdA.rtime : sdBActive ? sdB.rtime : null;

    const timeStr = rec && activeRemainMins != null
      ? formatRemainRaw(activeRemainMins)
      : '—';
    const timeCls = rec ? remainClassFromMins(activeRemainMins) : '';

    return `<div class="hdr-chip ${cls}">
      <span class="hdr-chip-name">${cam.config.label}</span>
      <span class="hdr-chip-time ${timeCls}">${timeStr}</span>
    </div>`;
  }).join('');
  updateRecAllButton();
}

// ── Panel rendering ──────────────────────────────────────────
function getPanel(camId) { return document.getElementById(`panel-${camId}`); }

/**
 * Fingerprint of the status fields that affect the rendered control layout.
 * TC is intentionally excluded — it updates every second but is patched
 * in-place by patchLiveValues(), avoiding a full DOM rebuild on each tick.
 */
function controlFingerprint(connected, s) {
  if (!connected) return 'disconnected';
  return JSON.stringify([
    s.rec, s.recfmt, s.camid,
    s.Ozoom?.pos,
    s.Oirisinfo?.Ovalue?.pv,  s.Oirisinfo?.Omode?.pv,
    s.Oisogaininfo?.Ovalue?.pv, s.Oisogaininfo?.Omode?.pv,
    s.Oshutterinfo?.Ovalue?.pv, s.Oshutterinfo?.Omode?.pv,
    s.Ondinfo?.Ovalue?.pv,
    s.Oaesinfo?.Ovalue?.pv,
    s.Owbinfo?.Omode?.pv,
    s.Owbinfo?.Okelvin?.kelvinvalue, s.Owbinfo?.Okelvin?.ccvalue,
    localStorage.getItem('wb_preset_a'), localStorage.getItem('wb_preset_b'),
    s.Ofocusinfo?.Oafmode?.pv, s.Ofocusinfo?.Ofacedat?.pv,
    s.Ofullauto?.pv,
    s.Opower?.Obatt?.percent,  s.Opower?.Obatt?.rtime,
    s.Omedia?.Osda?.state, s.Omedia?.Osda?.select, s.Omedia?.Osda?.rtime,
    s.Omedia?.Osdb?.state, s.Omedia?.Osdb?.select, s.Omedia?.Osdb?.rtime,
  ]);
}

/** TC removed from layout — no live patch needed. Stub kept so renderCam() caller is unchanged. */
function patchLiveValues(camId, s) { // eslint-disable-line no-unused-vars
}

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
  dot.className = `status-dot ${connected ? 'connected' : cam.connecting ? 'connecting' : 'disconnected'}`;

  const body = panel.querySelector('.cam-body');

  if (!connected) {
    body.innerHTML = cam.connecting ? connectingHTML(config) : disconnectedHTML(config, camId);
    attachBodyListeners(camId, panel);
    cam._fp = null;
    return;
  }

  const fp = controlFingerprint(connected, status);
  if (fp === cam._fp) {
    // Only live values (TC) may have changed — patch in-place, no DOM rebuild.
    patchLiveValues(camId, status);
    return;
  }

  // Control state changed — full rebuild needed.
  cam._fp = fp;
  body.innerHTML = connectedHTML(camId, status, recording, config, cam.locked);
  panel.classList.toggle('panel-locked', !!cam.locked);
  attachBodyListeners(camId, panel);
}

function connectingHTML(config) {
  return `<div class="cam-placeholder">
    <div class="connecting-spinner"></div>
    <p>Connecting to ${config.ip}…</p>
  </div>`;
}

function disconnectedHTML(config, camId) {
  const msg = config.ip ? `Not connected · ${config.ip}` : 'No camera configured';
  return `<div class="cam-placeholder">
    <p>${msg}</p>
    <button class="btn btn-primary btn-connect-panel" data-action="connect" data-camid="${camId}">Connect</button>
  </div>`;
}

function connectedHTML(camId, s, recording, config, locked) {
  // ── Timecode ──────────────────────────────────────────────
  const tc = formatTC(s.tc);

  // ── Battery ───────────────────────────────────────────────
  const batt      = s.Opower?.Obatt;
  const battPct   = batt?.percent;
  const battValid = battPct != null && battPct !== 'non' && battPct !== '?';
  const battStr   = battValid ? `${battPct}%` : null;
  const battRtime = battValid ? batt?.rtime : null;
  const battRemStr = formatRemainMins(battRtime);

  // ── SD Cards ──────────────────────────────────────────────
  const sdA         = s.Omedia?.Osda;
  const sdB         = s.Omedia?.Osdb;
  const sdAPresent  = sdA?.state != null && sdA.state !== 'n';
  const sdBPresent  = sdB?.state != null && sdB.state !== 'n';
  const sdAActive   = sdAPresent && sdA.select === 1;
  const sdBActive   = sdBPresent && sdB.select === 1;
  const sdAProtect  = sdA?.state === 'protect';
  const sdBProtect  = sdB?.state === 'protect';
  const sdARtime    = sdAPresent ? sdA.rtime : null;
  const sdBRtime    = sdBPresent ? sdB.rtime : null;
  const sdARemStr   = sdAPresent ? formatRemainMins(sdARtime) : '—';
  const sdBRemStr   = sdBPresent ? formatRemainMins(sdBRtime) : '—';

  // Total time remaining = sum of all present cards with known time (rtime ≥ 0).
  // rtime of -1 means "unknown" — exclude those from the sum.
  // Colour is driven by the lowest card (the soonest constraint).
  const _validRtimes = [sdARtime, sdBRtime].filter(t => t != null && t >= 0);
  const totalRemainMins = _validRtimes.length > 0 ? _validRtimes.reduce((a, b) => a + b, 0) : null;
  const _minRtime    = _validRtimes.length > 0 ? Math.min(..._validRtimes) : null;
  const rCls         = remainClassFromMins(_minRtime);

  // ── Iris ──────────────────────────────────────────────────
  const irisV      = s.Oirisinfo?.Ovalue?.pv || '—';
  const irisMode   = s.Oirisinfo?.Omode?.pv  || '';
  const autoIris   = irisMode === 'autoiris';
  const irisAdj    = s.Oirisinfo?.adjen === 1;   // can nudge iris remotely

  // ── Gain / ISO ────────────────────────────────────────────
  const gainV      = s.Oisogaininfo?.Ovalue?.pv || '—';
  const gainMode   = s.Oisogaininfo?.Omode?.pv  || '';
  const autoGain   = gainMode === 'autogain';
  const gainLbl    = gainMode.toLowerCase().includes('iso') ? 'ISO' : 'Gain';
  const gainAdj    = s.Oisogaininfo?.adjen === 1;

  // ── Shutter ───────────────────────────────────────────────
  // mode: "speed" (1/N) | "angle" (degrees) | "cls" (Hz) | "slow" | "auto" | "off"
  const shutterV    = s.Oshutterinfo?.Ovalue?.pv || '—';
  const shutterMode = s.Oshutterinfo?.Omode?.pv  || '';
  const shutterAdj  = s.Oshutterinfo?.adjen === 1;

  // ── ND Filter ─────────────────────────────────────────────
  const ndV    = s.Ondinfo?.Ovalue?.pv;
  const ndStr  = ndV ? (ndV === 'off' ? 'OFF' : ndV) : '—';
  const ndAdj  = s.Ondinfo?.adjen === 1;

  // ── AES ───────────────────────────────────────────────────
  const aesV   = s.Oaesinfo?.Ovalue?.pv || '—';
  const aesAdj = s.Oaesinfo?.adjen === 1;

  // ── White Balance ─────────────────────────────────────────
  const wbMode      = s.Owbinfo?.Omode?.pv || '';
  const autoWB      = wbMode === 'awb';
  const wbDisplay   = wbMode ? (WB_LABELS[wbMode] || wbMode) : '—';

  // K and CC values from camera (only valid in kelvin mode)
  const _wbKelvin   = s.Owbinfo?.Okelvin;
  const _wbKStr     = _wbKelvin?.kelvinvalue;
  const _wbCCStr    = _wbKelvin?.ccvalue;
  const wbKAdjustable = wbMode === 'kelvin';
  const wbK    = parseInt(_wbKStr  || '5600', 10);
  const wbCC   = parseInt(_wbCCStr || '0', 10);

  // K nudge: step through the camera's valid Kelvin list (arbitrary values are silently ignored).
  // If current K isn't in the list, snap to the nearest value above/below.
  // CC nudge: absolute setprop?wbvc=N — camera accepts integers -20..+20.
  // Empty string = no-op (click handler skips empty commands).
  const _kIdx    = KELVIN_STEPS.indexOf(wbK);
  const _kUp     = _kIdx >= 0 ? _kIdx + 1 : KELVIN_STEPS.findIndex(v => v > wbK);
  const _kDn     = _kIdx > 0  ? _kIdx - 1
    : _kIdx === 0 ? -1
    : (() => { for (let i = KELVIN_STEPS.length - 1; i >= 0; i--) if (KELVIN_STEPS[i] < wbK) return i; return -1; })();
  const wbKPlus   = (_kUp  >= 0 && _kUp  < KELVIN_STEPS.length) ? `setprop?wbvk=${KELVIN_STEPS[_kUp]}`  : '';
  const wbKMinus  = (_kDn  >= 0)                                 ? `setprop?wbvk=${KELVIN_STEPS[_kDn]}`  : '';
  // Positive CC values must be sent as %2B1, %2B2, etc. — the camera's valid list uses "+1", "+2", etc.
  // In URL query strings, a bare '+' is decoded as a space, so 'wbvc=1' doesn't match '+1'.
  const _ccEncode = n => n > 0 ? `%2B${n}` : `${n}`;
  const wbCCPlus  = wbCC < CC_MAX ? `setprop?wbvc=${_ccEncode(wbCC + 1)}` : '';
  const wbCCMinus = wbCC > CC_MIN ? `setprop?wbvc=${_ccEncode(wbCC - 1)}` : '';

  const wbKDisplay  = _wbKStr  ? `${wbK}K` : '—';
  // Show CC whenever camera has sent it (including "+0"); '—' only if not yet received
  const wbCCDisplay = _wbCCStr != null ? (wbCC >= 0 ? `+${wbCC}` : `${wbCC}`) : '—';

  // Dashboard WB presets A and B (stored in localStorage)
  const wbPresetA = getWbPreset('a');
  const wbPresetB = getWbPreset('b');

  // ── Focus / AF ────────────────────────────────────────────
  const afMode      = s.Ofocusinfo?.Oafmode?.pv || '';
  const afActive    = afMode === 'continuous';
  const afAvailable = (s.Ofocusinfo?.trctrlen ?? 0) > 0 || s.Ofocusinfo?.Oafmode?.en === 1;
  const fdPv        = s.Ofocusinfo?.Ofacedat?.pv || '';
  const faceOn      = fdPv !== '' && fdPv !== 'off' && fdPv !== 'non';
  const faceAvail   = fdPv !== '' && fdPv !== 'non';  // 'non' = hardware doesn't support it

  // ── Full Auto ─────────────────────────────────────────────
  const fullAuto = s.Ofullauto?.pv === 'on';

  // ── Zoom ──────────────────────────────────────────────────
  // Ozoom absent, or pos=null → manual zoom lens; hide the section entirely.
  const hasZoom = s.Ozoom != null && s.Ozoom.pos != null;
  const zoomPos = hasZoom ? s.Ozoom.pos : null;  // 0–100

  // ── Misc ──────────────────────────────────────────────────
  const recFmt  = s.recfmt ? (RECFMT_LABELS[s.recfmt] || s.recfmt) : null;
  const camIdHw = s.camid  || null;

  // ── Toggle helper ─────────────────────────────────────────
  const tog = (active, label, cmd) =>
    `<button class="btn btn-xs btn-toggle${active ? ' is-active' : ''}" data-cmd="${cmd}" data-camid="${camId}">${label}</button>`;

  // ── Zoom bar + step position highlight ───────────────────
  // stepzoom=1…6 map to 0%, 20%, 40%, 60%, 80%, 100%
  const STEP_PCT = [0, 20, 40, 60, 80, 100];
  const nearStep = zoomPos != null
    ? STEP_PCT.reduce((best, pct, i) =>
        Math.abs(pct - zoomPos) < Math.abs(STEP_PCT[best] - zoomPos) ? i : best, 0) + 1
    : null;

  const stepBtn = (n, label) => {
    const active = nearStep === n;
    return `<button class="btn-ctrl btn-zoom-step${active ? ' is-active' : ''}" ` +
      `data-cmd="drivelens?stepzoom=${n}" data-camid="${camId}" ` +
      `title="Step zoom ${STEP_PCT[n-1]}%">${label}</button>`;
  };

  const zoomBarHTML = zoomPos != null ? `
    <div class="zoom-bar-wrap">
      <div class="zoom-bar-track"><div class="zoom-bar-fill" style="width:${zoomPos}%"></div></div>
      <span class="zoom-val">${zoomPos}%</span>
    </div>` : '';

  // ── Battery bar ───────────────────────────────────────────
  const battPctNum = battValid ? parseInt(battPct, 10) : null;
  const battBarClass = battPctNum != null && battPctNum <= 10 ? 'batt-critical'
                     : battPctNum != null && battPctNum <= 30 ? 'batt-warning' : '';
  const battHTML = battStr ? `
    <div class="batt-row">
      <span class="batt-icon">🔋</span>
      <div class="batt-track"><div class="batt-fill ${battBarClass}" style="width:${battPct}%"></div></div>
      <span class="batt-pct">${battStr}</span>
      ${battRemStr !== '—' ? `<span class="batt-rem">${battRemStr}</span>` : ''}
    </div>` : '';

  // Slot display: raw integer minutes to match camera screen ("120 mins")
  const sdARemHMS = sdAPresent ? formatRemainRaw(sdARtime) : '—';
  const sdBRemHMS = sdBPresent ? formatRemainRaw(sdBRtime) : '—';
  // Panel total: sum of all present cards with known time
  const totalRemainHMS = formatRemainRaw(totalRemainMins);

  return `
  <div class="panel-body${hasZoom ? '' : ' no-zoom'}">

    <!-- ═══ RECORDING ═══ -->
    <section class="panel-section section-rec">
      <div class="section-label">Recording</div>
      <div class="rec-layout">
        <button class="btn-rec${recording ? ' is-recording' : ''}" data-cmd="rec?cmd=trig" data-camid="${camId}">
          ${recording ? 'STOP' : 'REC'}
        </button>
        <div class="rec-info">
          <div class="rec-time-block">
            <div class="remain-label">Total Time Remaining</div>
            <div class="remain-total ${rCls}">${totalRemainHMS}</div>
          </div>
          <div class="slot-block">
            <div class="slot-row${sdAActive ? ' slot-active' : ''}${!sdAPresent ? ' slot-absent' : ''}">
              <span class="slot-lbl">Card A${sdAProtect ? ' 🔒' : ''}</span>
              <span class="slot-time">${sdARemHMS}</span>
            </div>
            <div class="slot-row${sdBActive ? ' slot-active' : ''}${!sdBPresent ? ' slot-absent' : ''}">
              <span class="slot-lbl">Card B${sdBProtect ? ' 🔒' : ''}</span>
              <span class="slot-time">${sdBRemHMS}</span>
            </div>
            <button class="btn btn-xs btn-outline btn-slot-select" data-cmd="rec?cmd=slot" data-camid="${camId}">Slot Select</button>
          </div>
        </div>
      </div>
    </section>

    <!-- ═══ IMAGE / EXPOSURE ═══ -->
    <section class="panel-section section-exp">
      <div class="section-label">Image / Exposure</div>

      <!-- Iris -->
      <div class="exp-row">
        <span class="exp-lbl">Iris</span>
        <div class="nudge-pair${irisAdj ? '' : ' unavailable'}">
          <button class="btn btn-xs" data-cmd="drivelens?iris=minus" data-camid="${camId}">−</button>
          <button class="btn btn-xs" data-cmd="drivelens?iris=plus"  data-camid="${camId}">+</button>
        </div>
        ${tog(autoIris, 'A', autoIris ? 'setprop?am=maniris' : 'setprop?am=autoiris')}
        <span class="exp-val">${irisV}</span>
      </div>

      <!-- Gain / ISO — no A toggle: physical L/M/H switch overrides gcm via BR API -->
      <div class="exp-row">
        <span class="exp-lbl">${gainLbl}</span>
        <div class="nudge-pair${gainAdj ? '' : ' unavailable'}">
          <button class="btn btn-xs" data-cmd="drivelens?gain=minus" data-camid="${camId}">−</button>
          <button class="btn btn-xs" data-cmd="drivelens?gain=plus"  data-camid="${camId}">+</button>
        </div>
        <span class="exp-val">${gainV}</span>
      </div>

      <!-- Shutter -->
      <div class="exp-row">
        <span class="exp-lbl">Shutter</span>
        <div class="nudge-pair${shutterAdj ? '' : ' unavailable'}">
          <button class="btn btn-xs" data-cmd="drivelens?shutter=minus" data-camid="${camId}">−</button>
          <button class="btn btn-xs" data-cmd="drivelens?shutter=plus"  data-camid="${camId}">+</button>
        </div>
        <span class="exp-val">${shutterV}</span>
      </div>

      <!-- ND Filter -->
      <div class="exp-row">
        <span class="exp-lbl">ND</span>
        <div class="nudge-pair${ndAdj ? '' : ' unavailable'}">
          <button class="btn btn-xs" data-cmd="drivelens?nd=minus" data-camid="${camId}">−</button>
          <button class="btn btn-xs" data-cmd="drivelens?nd=plus"  data-camid="${camId}">+</button>
        </div>
        <span class="exp-val">${ndStr}</span>
      </div>

      <!-- AES -->
      <div class="exp-row">
        <span class="exp-lbl">AES</span>
        <div class="nudge-pair${aesAdj ? '' : ' unavailable'}">
          <button class="btn btn-xs" data-cmd="drivelens?aes=minus" data-camid="${camId}">−</button>
          <button class="btn btn-xs" data-cmd="drivelens?aes=plus"  data-camid="${camId}">+</button>
        </div>
        <span class="exp-val">${aesV}</span>
      </div>

      <!-- WB mode — single AWB on/off toggle; off → switches to Kelvin for K/CC control -->
      <div class="exp-row">
        <span class="exp-lbl">WB</span>
        <div class="btn-group">
          <button class="btn btn-xs btn-toggle${autoWB ? ' is-active' : ''}"
            data-cmd="${autoWB ? 'setprop?wbm=kelvin' : 'setprop?wbm=awb'}"
            data-camid="${camId}" title="${autoWB ? 'Disable AWB → Kelvin mode' : 'Enable Auto White Balance'}">AWB</button>
        </div>
        <span class="exp-val">${wbDisplay}</span>
      </div>

      <!-- K nudge -->
      <div class="exp-row">
        <span class="exp-lbl">K</span>
        <div class="nudge-pair">
          <button class="btn btn-xs${wbKAdjustable ? '' : ' disabled'}" data-cmd="${wbKMinus}" data-camid="${camId}" title="Kelvin −100K">−</button>
          <button class="btn btn-xs${wbKAdjustable ? '' : ' disabled'}" data-cmd="${wbKPlus}"  data-camid="${camId}" title="Kelvin +100K">+</button>
        </div>
        <span class="exp-val">${wbKDisplay}</span>
      </div>

      <!-- CC nudge -->
      <div class="exp-row">
        <span class="exp-lbl">CC</span>
        <div class="nudge-pair">
          <button class="btn btn-xs${wbKAdjustable ? '' : ' disabled'}" data-cmd="${wbCCMinus}" data-camid="${camId}" title="CC −1">−</button>
          <button class="btn btn-xs${wbKAdjustable ? '' : ' disabled'}" data-cmd="${wbCCPlus}"  data-camid="${camId}" title="CC +1">+</button>
        </div>
        <span class="exp-val">${wbCCDisplay}</span>
      </div>

      <!-- Preset A -->
      <div class="exp-row">
        <span class="exp-lbl">WB-A</span>
        <div class="btn-group">
          <button class="btn btn-xs btn-toggle${wbPresetA ? '' : ' disabled'}" data-action="wb-apply" data-slot="a" data-camid="${camId}" title="Apply preset A to camera">Apply</button>
          <button class="btn btn-xs" data-action="wb-save" data-slot="a" data-camid="${camId}" title="Save current K/CC as preset A">Set</button>
        </div>
        <span class="exp-val">${fmtWbPreset(wbPresetA)}</span>
      </div>

      <!-- Preset B -->
      <div class="exp-row">
        <span class="exp-lbl">WB-B</span>
        <div class="btn-group">
          <button class="btn btn-xs btn-toggle${wbPresetB ? '' : ' disabled'}" data-action="wb-apply" data-slot="b" data-camid="${camId}" title="Apply preset B to camera">Apply</button>
          <button class="btn btn-xs" data-action="wb-save" data-slot="b" data-camid="${camId}" title="Save current K/CC as preset B">Set</button>
        </div>
        <span class="exp-val">${fmtWbPreset(wbPresetB)}</span>
      </div>
    </section>

    <!-- ═══ FOCUS ═══ -->
    <section class="panel-section section-focus">
      <div class="section-label">Focus</div>
      <div class="ctrl-btn-row">
        <button class="btn-ctrl" data-cmd="drivelens?fl=near3" data-camid="${camId}" title="Near coarse">N◀◀</button>
        <button class="btn-ctrl" data-cmd="drivelens?fl=near1" data-camid="${camId}" title="Near fine">N◀</button>
        <button class="btn-ctrl" data-cmd="drivelens?fl=far1"  data-camid="${camId}" title="Far fine">▶F</button>
        <button class="btn-ctrl" data-cmd="drivelens?fl=far3"  data-camid="${camId}" title="Far coarse">▶▶F</button>
      </div>
      <div class="ctrl-btn-row">
        <button class="btn-toggle btn-wide${!afActive ? ' is-active' : ''}${afAvailable ? '' : ' unavailable'}"
          data-cmd="${afActive ? 'drivelens?focus=trackcancel' : 'drivelens?focus=track'}"
          data-camid="${camId}" title="${afAvailable ? (afActive ? 'Hold focus (stop AF tracking)' : 'Release hold (resume AF tracking)') : 'AF not available on this camera'}">AF Hold</button>
        <button class="btn-toggle btn-wide${faceOn ? ' is-active' : ''}${faceAvail ? '' : ' unavailable'}"
          data-cmd="setprop?fdat=${faceOn ? 'off' : 'on'}"
          data-camid="${camId}" title="${faceAvail ? 'Face Detect' : 'Face Detect not available on this camera'}">Face Detect</button>
      </div>
    </section>

    <!-- ═══ ZOOM ═══ (hidden when Ozoom absent — manual zoom lens) -->
    ${hasZoom ? `
    <section class="panel-section section-zoom">
      <div class="ctrl-btn-row">
        ${stepBtn(1,'W')}${stepBtn(2,'20')}${stepBtn(3,'40')}${stepBtn(4,'60')}${stepBtn(5,'80')}${stepBtn(6,'T')}
      </div>
      ${zoomBarHTML}
      <div class="ctrl-btn-row">
        <button class="btn-ctrl zoom-wide" data-cmd="drivelens?zoom=wide1" data-camid="${camId}">◀ W</button>
        <button class="btn-ctrl zoom-tele" data-cmd="drivelens?zoom=tele1" data-camid="${camId}">T ▶</button>
      </div>
    </section>` : ''}

  </div>

  <!-- ═══ INFO BAR ═══ -->
  <div class="cam-info-bar">
    ${battStr ? `
    <div class="batt-block">
      <span class="batt-icon">🔋</span>
      <div class="batt-track"><div class="batt-fill ${battBarClass}" style="width:${battPct}%"></div></div>
      <span class="batt-pct">${battStr}</span>
      ${battRemStr !== '—' ? `<span class="batt-rem">${battRemStr}</span>` : ''}
    </div>` : ''}
    <div class="info-pills">
      ${recFmt  ? `<span class="info-pill">${recFmt}</span>` : ''}
      ${camIdHw ? `<span class="info-pill">${camIdHw}</span>` : ''}
      ${fullAuto ? `<span class="info-pill" style="color:var(--amber)">Full Auto</span>` : ''}
    </div>
    <div class="panel-footer-right">
      <button class="btn btn-xs btn-toggle${fullAuto ? ' is-active' : ''}"
        data-cmd="setprop?fullauto=${fullAuto ? 'off' : 'on'}"
        data-camid="${camId}">Full Auto</button>
      <button class="btn-lock${locked ? ' is-locked' : ''}" data-action="toggle-lock" data-camid="${camId}"
        title="${locked ? 'Unlock controls' : 'Lock controls (REC only)'}">
        ${locked ? '🔒' : '🔓'}
      </button>
      <button class="btn-disc" data-action="disconnect" data-camid="${camId}">Disconnect</button>
    </div>
  </div>`;
}

// ── Disconnect / remove / move helpers ──────────────────────

/** Stop the connection but keep the config saved — easy to reconnect. */
async function doSoftDisconnect(camId) {
  await apiDisconnect(camId);
  const cam = state.cameras[camId];
  cam.connected  = false;
  cam.connecting = false;
  cam.status     = {};
  cam._fp        = null;
  renderCam(camId);
  updateHeaderIndicators();
}

/** Stop the connection AND clear the config from this slot entirely. */
async function doRemove(camId) {
  const cam = state.cameras[camId];
  if (cam.connected || cam.connecting) await apiDisconnect(camId);
  cam.connected  = false;
  cam.connecting = false;
  cam.status     = {};
  cam._fp        = null;
  cam.config     = { ...CAM_DEFAULTS[camId], id: camId };
  deleteConfig(camId);
  renderCam(camId);
  updateHeaderIndicators();
}

/** Move (or swap) a camera config from one slot to another. */
async function doMove(fromId, toId) {
  const fromCam = state.cameras[fromId];
  const toCam   = state.cameras[toId];
  if (fromCam.connected || fromCam.connecting) await apiDisconnect(fromId);
  if (toCam.connected   || toCam.connecting)   await apiDisconnect(toId);

  // Swap configs
  const fromCfg = { ...fromCam.config };
  const toCfg   = { ...toCam.config };
  fromCam.config = { ...toCfg,   id: fromId, label: toCfg.ip   ? toCfg.label   : CAM_DEFAULTS[fromId].label };
  toCam.config   = { ...fromCfg, id: toId,   label: fromCfg.ip ? fromCfg.label : CAM_DEFAULTS[toId].label };

  // Reset state for both
  [fromId, toId].forEach(id => {
    const c = state.cameras[id];
    c.connected = false; c.connecting = false; c.status = {}; c._fp = null;
    if (c.config.ip) saveConfig(id, c.config);
    else deleteConfig(id);
  });

  // Auto-connect whichever slot now has a config
  [fromId, toId].forEach(id => {
    const c = state.cameras[id];
    if (c.config.ip) {
      c.connecting = true;
      apiConnect(id, c.config).catch(console.error);
    }
    renderCam(id);
  });
  updateHeaderIndicators();
}

// ── Listeners ────────────────────────────────────────────────
function attachBodyListeners(camId, panel) {
  panel.querySelectorAll('[data-cmd]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const cmd = el.dataset.cmd;
      const cid = el.dataset.camid;
      if (!cmd) return;  // empty = no-op (e.g. K/CC at range boundary)
      // When locked, only the REC/STOP button and the whole rec section work
      if (state.cameras[cid]?.locked && !el.classList.contains('btn-rec') &&
          !el.closest('.section-rec')) return;
      apiCommand(cid, cmd).catch(console.error);
    });
  });
  panel.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const action = el.dataset.action;
      const cid    = el.dataset.camid;

      if (action === 'connect')    { openModal(cid); return; }
      if (action === 'disconnect') { doSoftDisconnect(cid).catch(console.error); return; }

      if (action === 'toggle-lock') {
        const cam = state.cameras[cid];
        if (cam) {
          cam.locked = !cam.locked;
          cam._fp = null;  // force panel rebuild to update button state
          renderCam(cid);
        }
        return;
      }

      // All remaining actions are blocked when locked
      if (state.cameras[cid]?.locked) return;

      if (action === 'wb-save') {
        // Read current K/CC from camera status and save to localStorage
        const s     = state.cameras[cid]?.status || {};
        const kStr  = s.Owbinfo?.Okelvin?.kelvinvalue;
        const ccStr = s.Owbinfo?.Okelvin?.ccvalue;
        if (!kStr) { console.warn('[wb-save] No K value in camera status'); return; }
        saveWbPreset(el.dataset.slot, parseInt(kStr, 10), parseInt(ccStr || '0', 10));
        // Invalidate fingerprint so the preset label refreshes immediately
        const cam = state.cameras[cid];
        if (cam) cam._fp = null;
        renderCam(cid);
        return;
      }

      if (action === 'wb-apply') {
        // Apply stored preset: switch to kelvin mode, then set K and CC
        const preset = getWbPreset(el.dataset.slot);
        if (!preset) return;
        apiCommand(cid, 'setprop?wbm=kelvin')
          .then(() => apiCommand(cid, `setprop?wbvk=${preset.k}`))
          .then(() => apiCommand(cid, `setprop?wbvc=${preset.cc > 0 ? '%2B' + preset.cc : preset.cc}`))
          .catch(console.error);
        return;
      }
    });
  });
}

// ── Grid layout ──────────────────────────────────────────────
function updateGridLayout() {
  // Always show all 4 panels (empty slots show a Connect button)
  document.getElementById('camera-grid').setAttribute('data-active', '4');
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
          <button class="btn-connection btn-config" aria-label="Connection settings">Connection</button>
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
  const hasIP      = !!cfg.ip;
  const isConnected = !!(cam?.connected);

  document.getElementById('modal-title').textContent = `Camera Connection`;
  document.getElementById('form-camId').value        = camId;
  document.getElementById('form-label').value        = cfg.label    || '';
  document.getElementById('form-ip').value           = cfg.ip       || '';
  document.getElementById('form-username').value     = cfg.username || 'Full';
  document.getElementById('form-password').value     = cfg.password || '12345678';
  document.getElementById('form-protocol').value     = cfg.protocol || 'browserremote';

  // Show/hide action buttons based on state
  document.getElementById('btn-disconnect-cam').hidden = !isConnected;
  document.getElementById('btn-remove-cam').hidden     = !hasIP;

  // Move-to-slot section: only show when there's a config to move
  const moveGroup = document.getElementById('form-group-move');
  moveGroup.hidden = !hasIP;
  if (hasIP) {
    const sel = document.getElementById('form-move-slot');
    sel.innerHTML = '<option value="">Move to slot…</option>';
    CAM_IDS.forEach(id => {
      if (id === camId) return;
      const other = state.cameras[id]?.config;
      const label = other?.ip
        ? `${other.label} (${other.ip})`
        : `${CAM_DEFAULTS[id].label} (empty)`;
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = label;
      sel.appendChild(opt);
    });
  }

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
      config:     { ...CAM_DEFAULTS[id], ...(saved[id] || {}), id },
      connected:  false,
      connecting: false,
      status:     {},
      locked:     false,
    };
  });

  buildPanels();

  // Show connecting spinner immediately for any camera with a saved config.
  // The WS open handler checks /api/status and decides whether to use the
  // existing server connection or call apiConnect to start a fresh one.
  CAM_IDS.forEach(id => {
    if (state.cameras[id].config.ip) state.cameras[id].connecting = true;
  });

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
    state.cameras[camId].config     = config;
    state.cameras[camId].connecting = true;
    state.cameras[camId]._fp        = null;
    saveConfig(camId, config);
    closeModal();
    renderCam(camId);
    apiConnect(camId, config).catch(console.error);
  });

  document.getElementById('btn-disconnect-cam').addEventListener('click', async () => {
    const camId = _modalCamId;
    closeModal();
    if (camId) doSoftDisconnect(camId).catch(console.error);
  });

  document.getElementById('btn-update-name').addEventListener('click', () => {
    const camId = _modalCamId;
    if (!camId) return;
    const label = document.getElementById('form-label').value.trim() || CAM_DEFAULTS[camId].label;
    const cam = state.cameras[camId];
    cam.config.label = label;
    if (cam.config.ip) saveConfig(camId, { ...cam.config });
    // Update panel header name in place without a full re-render
    const nameEl = document.querySelector(`#panel-${camId} .cam-name`);
    if (nameEl) nameEl.textContent = label;
    // Update the header chips
    updateHeaderIndicators();
    closeModal();
  });

  document.getElementById('btn-remove-cam').addEventListener('click', async () => {
    const camId = _modalCamId;
    closeModal();
    if (camId) doRemove(camId).catch(console.error);
  });

  document.getElementById('btn-move-cam').addEventListener('click', async () => {
    const fromId = _modalCamId;
    const toId   = document.getElementById('form-move-slot').value;
    if (!fromId || !toId) return;
    closeModal();
    doMove(fromId, toId).catch(console.error);
  });

  // REC ALL
  document.getElementById('btn-rec-all').addEventListener('click', () => {
    CAM_IDS.forEach(id => {
      if (state.cameras[id]?.connected)
        apiCommand(id, 'rec?cmd=trig').catch(console.error);
    });
  });

  // Connect WebSocket — the server pushes current camera state to every new
  // WS client, so page refresh just re-receives whatever the server already knows.
  // Cameras only connect/disconnect via explicit user action (Connect / Disconnect).
  connectWS();
}

document.addEventListener('DOMContentLoaded', init);
