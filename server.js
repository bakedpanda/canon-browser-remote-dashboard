/**
 * Canon Browser Remote Dashboard – Backend Proxy Server
 *
 * Proxies HTTP requests to Canon XF cameras, managing per-camera
 * authentication sessions and broadcasting status updates via WebSocket.
 *
 * Copyright (C) 2024  Chris Whitehouse
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = 1000;

// ─── In-memory camera state ──────────────────────────────────────────────────

/** @type {Map<string, CameraSession>} keyed by cameraId ("cam1"–"cam4") */
const cameras = new Map();

/**
 * @typedef {Object} CameraConfig
 * @property {string} id        - "cam1" | "cam2" | "cam3" | "cam4"
 * @property {string} label     - User-defined name
 * @property {string} ip        - Camera IP address
 * @property {string} username  - Login username
 * @property {string} password  - Login password
 * @property {boolean} enabled  - Whether this slot is active
 */

/**
 * @typedef {Object} CameraSession
 * @property {CameraConfig} config
 * @property {string|null}  cookie      - Raw Set-Cookie string from login
 * @property {boolean}      connected
 * @property {Object}       status      - Latest parsed status data
 * @property {ReturnType<typeof setInterval>|null} pollTimer
 * @property {boolean}      polling
 */

function createSession(config) {
  return {
    config,
    cookie: null,
    connected: false,
    status: {},
    pollTimer: null,
    polling: false,
  };
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function broadcastStatus(camId) {
  const session = cameras.get(camId);
  if (!session) return;
  broadcast({
    type: 'status',
    camId,
    connected: session.connected,
    status: session.status,
    label: session.config.label,
    ip: session.config.ip,
  });
}

function broadcastAllStatus() {
  cameras.forEach((_, camId) => broadcastStatus(camId));
}

// ─── Camera API helpers ───────────────────────────────────────────────────────

function baseUrl(config) {
  return `http://${config.ip}`;
}

/**
 * Build headers for every camera request.
 * Canon XF web server requires HTTP Basic Auth on all endpoints.
 * Session cookie is appended when available (some firmware needs it).
 */
function cameraHeaders(session) {
  const { config } = session;
  const cred = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  const headers = { Authorization: `Basic ${cred}` };
  if (session.cookie) headers.Cookie = session.cookie;
  return headers;
}

/**
 * Login to a camera.
 * Sends Basic Auth + query-string credentials to /api/acnt/login,
 * then stores any session cookie returned for subsequent requests.
 */
async function login(session) {
  const { config } = session;
  const url = `${baseUrl(config)}/api/acnt/login?uname=${encodeURIComponent(config.username)}&pw=${encodeURIComponent(config.password)}`;
  try {
    const res = await fetch(url, {
      headers: cameraHeaders(session),
      timeout: 5000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (data.res !== 'ok') throw new Error(`Login rejected: ${data.res}`);

    // Store session cookie if the camera issues one
    const rawCookies = res.headers.raw()['set-cookie'] || [];
    if (rawCookies.length) {
      session.cookie = rawCookies.map((c) => c.split(';')[0]).join('; ');
    }
    session.connected = true;
    console.log(`[${config.id}] Logged in to ${config.ip}`);
    return true;
  } catch (err) {
    console.warn(`[${config.id}] Login failed: ${err.message}`);
    session.connected = false;
    session.cookie = null;
    return false;
  }
}

/**
 * Fetch camera status via /api/cam/getcurprop
 */
async function fetchStatus(session) {
  const { config } = session;
  const url = `${baseUrl(config)}/api/cam/getcurprop`;
  try {
    const res = await fetch(url, {
      headers: cameraHeaders(session),
      timeout: 4000,
    });

    if (res.status === 401 || res.status === 403) {
      console.log(`[${config.id}] Auth rejected, re-logging in…`);
      session.connected = false;
      session.cookie = null;
      await login(session);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    if (data.res === 'errsession') {
      session.connected = false;
      session.cookie = null;
      await login(session);
      return;
    }

    // Flatten the property list into a simple key→value map
    const flat = {};
    if (Array.isArray(data.prop)) {
      data.prop.forEach((p) => {
        if (p.k !== undefined) flat[p.k] = p.v;
      });
    } else if (typeof data === 'object') {
      Object.assign(flat, data);
    }

    session.status = flat;
    session.connected = true;
    broadcastStatus(config.id);
  } catch (err) {
    console.warn(`[${config.id}] Status poll failed: ${err.message}`);
    session.connected = false;
    broadcastStatus(config.id);
  }
}

/**
 * Send a control command to the camera.
 * cmd example: "rec?cmd=trig"  or  "drivelens?iris=plus"
 */
async function sendCommand(session, cmd) {
  const { config } = session;
  if (!session.connected) {
    throw new Error('Camera not connected');
  }
  const url = `${baseUrl(config)}/api/cam/${cmd}`;
  const res = await fetch(url, {
    headers: cameraHeaders(session),
    timeout: 5000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Polling lifecycle ────────────────────────────────────────────────────────

function startPolling(session) {
  if (session.pollTimer) return;
  session.polling = true;
  session.pollTimer = setInterval(() => fetchStatus(session), POLL_INTERVAL_MS);
  // Kick off immediately
  fetchStatus(session);
}

function stopPolling(session) {
  if (session.pollTimer) {
    clearInterval(session.pollTimer);
    session.pollTimer = null;
  }
  session.polling = false;
}

async function connectCamera(camId, config) {
  // Stop any existing session for this slot
  if (cameras.has(camId)) {
    stopPolling(cameras.get(camId));
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
  session.connected = false;
  session.cookie = null;
  cameras.delete(camId);
  broadcast({ type: 'disconnected', camId });
}

// ─── Express routes ───────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/** POST /api/connect  { camId, label, ip, username, password } */
app.post('/api/connect', async (req, res) => {
  const { camId, label, ip, username, password } = req.body;
  if (!camId || !ip) return res.status(400).json({ error: 'camId and ip required' });

  const config = {
    id: camId,
    label: label || camId,
    ip,
    username: username || 'Full',
    password: password || '12345678',
    enabled: true,
  };

  await connectCamera(camId, config);
  res.json({ ok: true });
});

/** POST /api/disconnect  { camId } */
app.post('/api/disconnect', (req, res) => {
  const { camId } = req.body;
  disconnectCamera(camId);
  res.json({ ok: true });
});

/** POST /api/command  { camId, cmd }  e.g. cmd="rec?cmd=trig" */
app.post('/api/command', async (req, res) => {
  const { camId, cmd } = req.body;
  const session = cameras.get(camId);
  if (!session) return res.status(404).json({ error: 'Camera not found' });

  try {
    const data = await sendCommand(session, cmd);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/status  – snapshot of all camera states */
app.get('/api/status', (req, res) => {
  const result = {};
  cameras.forEach((session, camId) => {
    result[camId] = {
      connected: session.connected,
      label: session.config.label,
      ip: session.config.ip,
      status: session.status,
    };
  });
  res.json(result);
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('Dashboard client connected');

  // Send current state to the new client
  cameras.forEach((session, camId) => {
    ws.send(
      JSON.stringify({
        type: 'status',
        camId,
        connected: session.connected,
        status: session.status,
        label: session.config.label,
        ip: session.config.ip,
      })
    );
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'command') {
        const session = cameras.get(msg.camId);
        if (session) {
          try {
            await sendCommand(session, msg.cmd);
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', camId: msg.camId, error: err.message }));
          }
        }
      }
    } catch (_) {}
  });

  ws.on('close', () => console.log('Dashboard client disconnected'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Canon Remote Dashboard running → http://localhost:${PORT}`);
});
