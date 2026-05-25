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

  // Logout first – send WITHOUT a cookie so the camera kicks any active session,
  // not just ours.  This is the most reliable way to clear a competing client.
  const logoutHeaders = {
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`,
  };
  try {
    await fetch(`${baseUrl(config)}/api/acnt/logout`, { headers: logoutHeaders, timeout: 3000 });
    await new Promise(r => setTimeout(r, 400)); // give camera time to clear the slot
  } catch (_) {}

  const url = `${baseUrl(config)}/api/acnt/login`
    + `?uname=${encodeURIComponent(config.username)}`
    + `&pw=${encodeURIComponent(config.password)}`;

  try {
    const res = await fetch(url, { headers: logoutHeaders, timeout: 5000 });
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

  // Canon Browser Remote uses long-polling via getcurprop:
  //   seq=0  → camera responds immediately with ALL current properties
  //   seq=N  → camera holds the connection until something changes (up to ~30s)
  //            then returns only the CHANGED properties (delta)
  //
  // 'busy' means one long-poll is already pending on the camera – we must
  // wait for it to expire (~30s) before the slot is free again.
  // Fix: use a 35-second timeout so we always outlast the camera's own
  // 30-second hold, preventing the busy cycle.

  const base = session.statusEndpoint; // base path, e.g. '/api/cam/getcurprop'
  const isLongPoll = !base || base.includes('getcurprop');
  const timeout = isLongPoll ? 35000 : 8000;

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
    const epIsLongPoll = endpoint.includes('getcurprop');
    try {
      const res = await fetch(url, {
        headers: cameraHeaders(session),
        timeout: epIsLongPoll ? 35000 : 8000,
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
        console.log(`[${config.id}] Session expired mid-poll – re-logging in`);
        session.connected = false;
        session.cookie    = null;
        session.statusEndpoint = null;
        session._debugLogged   = false;
        await login(session);
        // Back off 3 s after re-login to let the camera settle
        return 3000;
      }

      if (data.res === 'failparam') {
        console.log(`[${config.id}] ${endpoint} → failparam, trying next…`);
        continue;
      }

      if (data.res === 'busy') {
        // Another client holds the long-poll slot.  Record the endpoint and
        // back off for 6 s to give the competing request time to expire,
        // rather than hammering the camera every second.
        if (!session.statusEndpoint && epIsLongPoll) {
          session.statusEndpoint = endpoint.split('?')[0];
          console.log(`[${config.id}] Long-poll endpoint confirmed (busy): ${session.statusEndpoint} – backing off 6 s…`);
        } else {
          console.log(`[${config.id}] Camera busy – backing off 6 s…`);
        }
        // Do NOT mark disconnected; return 6 s backoff hint.
        return 6000;
      }

      // Any other non-ok result → skip this candidate
      if (data.res && data.res !== 'ok') {
        console.log(`[${config.id}] ${endpoint} → res="${data.res}", trying next…`);
        continue;
      }

      // ── Success ──────────────────────────────────────────────────────────────
      if (!session._debugLogged) {
        session.statusEndpoint = endpoint.split('?')[0];
        console.log(`[${config.id}] Status endpoint: ${session.statusEndpoint}`);
        console.log(`[${config.id}] Raw sample:`, JSON.stringify(data).slice(0, 800));
        session._debugLogged = true;
      }

      // Advance seq using camera's value if provided
      if (data.seq != null) session.seq = Number(data.seq);
      else session.seq++;

      // Flatten prop list or flat object
      const flat = {};
      if (Array.isArray(data.prop)) {
        data.prop.forEach(p => { if (p.k != null) flat[p.k] = p.v; });
      } else {
        Object.entries(data).forEach(([k, v]) => {
          if (k !== 'res' && k !== 'seq') flat[k] = v;
        });
      }

      if (epIsLongPoll && Object.keys(session.status).length > 0) {
        // getcurprop returns delta (changed props only) – merge into existing status
        Object.assign(session.status, flat);
      } else {
        // getprop or first response – replace entirely
        session.status = flat;
      }

      session.connected = true;
      broadcastStatus(config.id);
      return;

    } catch (err) {
      if (epIsLongPoll && err.message && err.message.includes('timeout')) {
        // Long-poll timed out on our side – camera had nothing to report.
        // Advance seq so next request isn't treated as a duplicate.
        session.seq++;
        console.log(`[${config.id}] Long-poll timeout (no changes) – seq now ${session.seq}`);
        return; // stay connected
      }
      console.warn(`[${config.id}] Poll ${endpoint}: ${err.message}`);
    }
  }

  // All candidates failed – genuinely unreachable
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
  // fetchStatus returns a delay hint (ms) when it wants to back off
  // (e.g. camera slot busy, or session conflict).
  while (session.polling) {
    const delay = await fetchStatus(session) || POLL_INTERVAL;
    if (session.polling) {
      await new Promise(r => setTimeout(r, delay));
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

/**
 * GET /api/camfetch/:camId?path=/some/path
 * Authenticated proxy – fetches any path from the camera as text.
 * Used for API discovery: e.g. fetch camera JS to find real endpoint names.
 */
app.get('/api/camfetch/:camId', async (req, res) => {
  const session = cameras.get(req.params.camId);
  if (!session) return res.status(404).json({ error: 'Camera not found' });
  const camPath = req.query.path;
  if (!camPath) return res.status(400).json({ error: 'path query param required' });
  try {
    const r = await fetch(`${baseUrl(session.config)}${camPath}`, {
      headers: cameraHeaders(session), timeout: 8000,
    });
    const text = await r.text();
    res.set('Content-Type', 'text/plain').send(`HTTP ${r.status}\n\n${text}`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/probe/:camId
 * Tries a broad list of candidate status endpoints and reports what each returns.
 */
app.get('/api/probe/:camId', async (req, res) => {
  const session = cameras.get(req.params.camId);
  if (!session) return res.status(404).json({ error: 'Camera not found' });

  const paths = [
    '/api/cam/getprop', '/api/cam/getcurprop', '/api/cam/getallprop',
    '/api/cam/prop',    '/api/cam/curprop',     '/api/cam/status',
    '/api/cam/getstatus', '/api/cam/info',      '/api/cam/getinfo',
    '/api/cam/getprop?seq=0', '/api/cam/getcurprop?seq=0',
    '/api/cam/getprop?k=rec', '/api/cam/getcurprop?k=rec',
    '/api/info',        '/api/status',          '/api/cam',
    '/api/cam/getcurprop?propid=0', '/api/cam/getprop?propid=0',
  ];

  const results = [];
  for (const p of paths) {
    try {
      const r = await fetch(`${baseUrl(session.config)}${p}`, {
        headers: cameraHeaders(session), timeout: 4000,
      });
      const text = await r.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 200); }
      results.push({ path: p, status: r.status, body: parsed });
    } catch (err) {
      results.push({ path: p, error: err.message });
    }
  }
  res.json(results);
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
