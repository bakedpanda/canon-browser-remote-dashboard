/**
 * Canon Browser Remote Dashboard – Backend Proxy Server
 *
 * Acts as a single authenticated proxy to Canon XF/C-series cameras,
 * managing sessions so the dashboard and Bitfocus Companion can share
 * camera access without session conflicts.
 *
 * Copyright (C) 2024  Chris Whitehouse
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

'use strict';

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const fetch   = require('node-fetch');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT            = process.env.PORT || 8847;
const POLL_INTERVAL   = 1000;   // ms between status polls
const LOGIN_SETTLE_MS = 600;    // ms to wait after login before first poll

// ─── Protocol registry ────────────────────────────────────────────────────────
// Groundwork for future XC protocol support.
// Each entry describes how to connect/poll/command a camera type.
//
// 'browserremote' – Canon XF/C-series Browser Remote HTTP API  (implemented)
// 'xcprotocol'    – Canon XC-series UDP/TCP control protocol   (future)
const PROTOCOLS = {
  browserremote: { label: 'XF / C Series (Browser Remote)', implemented: true  },
  xcprotocol:    { label: 'XC Series (XC Protocol)',         implemented: false },
};

// ─── Session state ────────────────────────────────────────────────────────────

/** @type {Map<string, CameraSession>} */
const cameras = new Map();

function createSession(config) {
  return {
    config,
    cookie:         null,
    connected:      false,
    status:         {},
    pollTimer:      null,
    seq:            0,         // sequence counter for poll requests
    statusEndpoint: null,      // discovered dynamically per firmware
    _debugLogged:   false,
  };
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function broadcastStatus(camId) {
  const s = cameras.get(camId);
  if (!s) return;
  broadcast({
    type:      'status',
    camId,
    connected: s.connected,
    status:    s.status,
    label:     s.config.label,
    ip:        s.config.ip,
    protocol:  s.config.protocol,
  });
}

// ─── Browser Remote API helpers ───────────────────────────────────────────────

function baseUrl(config) {
  return `http://${config.ip}`;
}

function cameraHeaders(session) {
  const { config } = session;
  const cred = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  const h = { Authorization: `Basic ${cred}` };
  if (session.cookie) h.Cookie = session.cookie;
  return h;
}

/**
 * Login.  Attempts logout first to clear any stale session (errsession).
 */
async function login(session) {
  const { config } = session;

  // Clear any existing session to avoid errsession
  try {
    await fetch(`${baseUrl(config)}/api/acnt/logout`, {
      headers: cameraHeaders(session),
      timeout: 2000,
    });
    await new Promise(r => setTimeout(r, 200));
  } catch (_) {}

  const url = `${baseUrl(config)}/api/acnt/login`
    + `?uname=${encodeURIComponent(config.username)}`
    + `&pw=${encodeURIComponent(config.password)}`;

  try {
    const res = await fetch(url, { headers: cameraHeaders(session), timeout: 5000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (data.res !== 'ok') throw new Error(`Login rejected: ${data.res}`);

    const rawCookies = res.headers.raw()['set-cookie'] || [];
    if (rawCookies.length) {
      session.cookie = rawCookies.map(c => c.split(';')[0]).join('; ');
    }
    session.connected = true;
    console.log(`[${config.id}] ✓ Logged in to ${config.ip}`);
    return true;
  } catch (err) {
    console.warn(`[${config.id}] Login failed: ${err.message}`);
    session.connected = false;
    session.cookie    = null;
    return false;
  }
}

/**
 * Poll camera status.  Tries multiple endpoint patterns so it works
 * across XF705, XF405, C200, C100mk2 and similar firmware variants.
 */
async function fetchStatus(session) {
  const { config } = session;

  // Build candidate list.
  // Prefer getprop (returns immediately) over getcurprop (long-poll, can return "busy"
  // if a previous request is still pending).  Store only the base path so the seq
  // parameter can be appended dynamically each call.
  const base = session.statusEndpoint; // e.g. '/api/cam/getprop' – no query string
  const candidates = base
    ? [`${base}?seq=${session.seq}`, base]
    : [
        `/api/cam/getprop`,
        `/api/cam/getprop?seq=${session.seq}`,
        `/api/cam/getcurprop`,
        `/api/cam/getcurprop?seq=${session.seq}`,
      ];

  for (const endpoint of candidates) {
    const url = `${baseUrl(config)}${endpoint}`;
    try {
      const res = await fetch(url, {
        headers: cameraHeaders(session),
        timeout: 8000,
      });

      if (res.status === 401 || res.status === 403) {
        console.log(`[${config.id}] Session expired – re-logging in`);
        session.connected = false;
        session.cookie    = null;
        session.statusEndpoint = null;
        session._debugLogged   = false;
        await login(session);
        return;
      }
      if (!res.ok) continue;

      const data = await res.json();

      if (data.res === 'errsession') {
        session.connected = false;
        session.cookie    = null;
        session.statusEndpoint = null;
        session._debugLogged   = false;
        await login(session);
        return;
      }

      // 'busy' means a long-poll request is still in flight – skip this candidate.
      // 'failparam' means wrong endpoint/params for this firmware.
      if (data.res === 'busy' || data.res === 'failparam') {
        if (data.res === 'failparam') console.log(`[${config.id}] ${endpoint} → failparam, trying next…`);
        continue;
      }

      // Any non-ok result we don't recognise → skip
      if (data.res && data.res !== 'ok') {
        console.log(`[${config.id}] ${endpoint} → unexpected res="${data.res}", trying next…`);
        continue;
      }

      // ── Success ──────────────────────────────────────────────────────────────
      // Record the base endpoint (strip query string so seq stays dynamic)
      if (!session._debugLogged) {
        session.statusEndpoint = endpoint.split('?')[0];
        console.log(`[${config.id}] Status endpoint: ${session.statusEndpoint}`);
        console.log(`[${config.id}] Raw sample:`, JSON.stringify(data).slice(0, 800));
        session._debugLogged = true;
      }

      // Update seq from camera's response if present, otherwise increment ours
      if (data.seq != null) session.seq = Number(data.seq);
      else session.seq++;

      // Flatten prop array or flat object into key→value map
      const flat = {};
      if (Array.isArray(data.prop)) {
        data.prop.forEach(p => { if (p.k != null) flat[p.k] = p.v; });
      } else {
        // Some firmware returns a flat object; copy everything except 'res'/'seq'
        Object.entries(data).forEach(([k, v]) => {
          if (k !== 'res' && k !== 'seq') flat[k] = v;
        });
      }

      session.status    = flat;
      session.connected = true;
      broadcastStatus(config.id);
      return; // success – don't try further candidates

    } catch (err) {
      console.warn(`[${config.id}] Poll ${endpoint}: ${err.message}`);
    }
  }

  // All candidates failed
  session.connected = false;
  broadcastStatus(config.id);
}

async function sendCommand(session, cmd) {
  if (!session.connected) throw new Error('Camera not connected');
  const url = `${baseUrl(session.config)}/api/cam/${cmd}`;
  const res = await fetch(url, { headers: cameraHeaders(session), timeout: 5000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Polling lifecycle ────────────────────────────────────────────────────────

async function startPolling(session) {
  if (session.polling) return;
  session.polling = true;
  // Brief delay so the camera session settles after login
  await new Promise(r => setTimeout(r, LOGIN_SETTLE_MS));

  // Sequential poll loop – waits for each response before scheduling the next.
  // This avoids "busy" errors that occur when a second request arrives while
  // a long-poll (getcurprop) is still holding the connection open.
  while (session.polling) {
    await fetchStatus(session);
    if (session.polling) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
  }
}

function stopPolling(session) {
  session.polling   = false;  // causes the loop in startPolling to exit cleanly
  session.pollTimer = null;   // kept for API compatibility (no longer an interval)
}

async function connectCamera(camId, config) {
  // Tear down any existing session for this slot
  if (cameras.has(camId)) stopPolling(cameras.get(camId));

  // XC Protocol – groundwork only, not yet implemented
  if (config.protocol === 'xcprotocol') {
    console.log(`[${camId}] XC Protocol selected – not yet implemented`);
    broadcast({ type: 'error', camId, error: 'XC Protocol is not yet implemented' });
    return;
  }

  const session = createSession(config);
  cameras.set(camId, session);

  const ok = await login(session);
  if (ok) {
    startPolling(session);
  } else {
    broadcastStatus(camId);
    // Retry login every 5 s
    const retryTimer = setInterval(async () => {
      if (!cameras.has(camId) || cameras.get(camId) !== session) {
        clearInterval(retryTimer);
        return;
      }
      const success = await login(session);
      if (success) {
        clearInterval(retryTimer);
        startPolling(session);
        broadcastStatus(camId);
      }
    }, 5000);
  }
}

function disconnectCamera(camId) {
  if (!cameras.has(camId)) return;
  const session = cameras.get(camId);
  stopPolling(session);
  // Attempt polite logout
  try {
    fetch(`${baseUrl(session.config)}/api/acnt/logout`, {
      headers: cameraHeaders(session),
      timeout: 2000,
    }).catch(() => {});
  } catch (_) {}
  session.connected = false;
  session.cookie    = null;
  cameras.delete(camId);
  broadcast({ type: 'disconnected', camId });
}

// ─── HTTP API ─────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/** POST /api/connect */
app.post('/api/connect', async (req, res) => {
  const { camId, label, ip, username, password, protocol } = req.body;
  if (!camId || !ip) return res.status(400).json({ error: 'camId and ip required' });

  await connectCamera(camId, {
    id:       camId,
    label:    label    || camId,
    ip,
    username: username || 'Full',
    password: password || '12345678',
    protocol: protocol || 'browserremote',
  });
  res.json({ ok: true });
});

/** POST /api/disconnect */
app.post('/api/disconnect', (req, res) => {
  disconnectCamera(req.body.camId);
  res.json({ ok: true });
});

/** POST /api/command  { camId, cmd } */
app.post('/api/command', async (req, res) => {
  const { camId, cmd } = req.body;
  const session = cameras.get(camId);
  if (!session) return res.status(404).json({ error: 'Camera not found' });
  try {
    res.json(await sendCommand(session, cmd));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/status */
app.get('/api/status', (req, res) => {
  const result = {};
  cameras.forEach((s, camId) => {
    result[camId] = { connected: s.connected, label: s.config.label, ip: s.config.ip, status: s.status };
  });
  res.json(result);
});

/** GET /api/rawstatus/:camId – raw getcurprop for debugging */
app.get('/api/rawstatus/:camId', async (req, res) => {
  const session = cameras.get(req.params.camId);
  if (!session) return res.status(404).json({ error: 'Camera not found' });
  try {
    const r = await fetch(`${baseUrl(session.config)}/api/cam/getcurprop`, {
      headers: cameraHeaders(session), timeout: 4000,
    });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/protocols – list supported protocols */
app.get('/api/protocols', (req, res) => res.json(PROTOCOLS));

// ─── Companion API ────────────────────────────────────────────────────────────
// These endpoints let Bitfocus Companion control cameras through this
// dashboard so only one session per camera is ever open.
//
// Use Companion's built-in HTTP Request module pointing at:
//   http://<dashboard-host>:8847/companion/...
//
// Or write a custom Companion module using the WebSocket at the same host/port.
//   WS message format → send:    { type:"command", camId:"cam1", cmd:"rec?cmd=trig" }
//   WS message format → receive: { type:"status",  camId:"cam1", connected:true, status:{...} }

/** GET /companion/status – flat status map for all cameras (Companion variables) */
app.get('/companion/status', (req, res) => {
  const result = {};
  cameras.forEach((s, camId) => {
    result[camId] = {
      connected: s.connected,
      label:     s.config.label,
      ip:        s.config.ip,
      ...s.status,
    };
  });
  res.json(result);
});

/** GET /companion/status/:camId – single camera status */
app.get('/companion/status/:camId', (req, res) => {
  const s = cameras.get(req.params.camId);
  if (!s) return res.status(404).json({ error: 'Camera not found' });
  res.json({ connected: s.connected, label: s.config.label, ...s.status });
});

/** POST /companion/command  { camId, cmd } */
app.post('/companion/command', async (req, res) => {
  const { camId, cmd } = req.body;
  const session = cameras.get(camId);
  if (!session) return res.status(404).json({ error: 'Camera not found' });
  try {
    res.json(await sendCommand(session, cmd));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /companion/cameras – list all configured camera slots */
app.get('/companion/cameras', (req, res) => {
  const list = [];
  cameras.forEach((s, camId) => {
    list.push({ camId, label: s.config.label, ip: s.config.ip, connected: s.connected });
  });
  res.json(list);
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  // Push current state to newly connected client (dashboard or Companion)
  cameras.forEach((s, camId) => {
    ws.send(JSON.stringify({
      type: 'status', camId,
      connected: s.connected, status: s.status,
      label: s.config.label, ip: s.config.ip,
    }));
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'command') {
        const session = cameras.get(msg.camId);
        if (session) {
          try { await sendCommand(session, msg.cmd); }
          catch (err) {
            ws.send(JSON.stringify({ type: 'error', camId: msg.camId, error: err.message }));
          }
        }
      }
    } catch (_) {}
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Canon Remote Dashboard  →  http://localhost:${PORT}`);
  console.log(`Companion API           →  http://localhost:${PORT}/companion/`);
});
