# Canon Browser Remote Dashboard

A responsive multi-camera control dashboard for **Canon XF-series cameras** (XF405, XF705, and compatible models) using Canon's Browser Remote API.

Monitor and control up to **4 cameras simultaneously** from a single web page. When all four slots are active the screen is divided into quadrants — one per camera. The layout adapts automatically as cameras are added or removed.

![Dashboard screenshot placeholder](docs/screenshot.png)

---

## Features

| Category | Details |
|---|---|
| **Multi-camera** | Up to 4 cameras, each in its own quadrant |
| **Live status** | Recording state, timecode, battery %, SD card remaining |
| **Exposure readout** | Iris, Gain/ISO, Shutter, ND filter, White balance |
| **Focus & Zoom** | AF mode display, nudge focus near/far, zoom W/T |
| **One-click controls** | Record trigger, SD slot switch, Auto iris, AWB, Full Auto |
| **Per-camera config** | IP address, username, password stored in browser localStorage |
| **Auto-reconnect** | Re-authenticates automatically if session expires |
| **Responsive** | Stacks to single column on narrow screens |

---

## Supported Cameras

- Canon XF705
- Canon XF405 / XF400
- Canon XF305 / XF300 (may work)
- Canon C100 Mark II (partial — see notes)

The dashboard targets the same **Browser Remote API** used by Canon's built-in web interface.

---

## Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- Camera(s) connected to your network with Browser Remote enabled
- A modern web browser (Chrome, Firefox, Safari, Edge)

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/chriswhitehouse/canon-browser-remote-dashboard.git
cd canon-browser-remote-dashboard

# Install dependencies
npm install

# Start the proxy server
npm start
```

Open **http://localhost:3000** in your browser.

> **Why a local server?**  
> Canon cameras use cookie-based session authentication. A thin Node.js proxy handles login cookies and sidesteps browser CORS restrictions so the dashboard can talk to cameras on your LAN.

---

## Configuration

1. Click the **⚙ gear icon** in any camera quadrant.
2. Enter the camera's **IP address** (find it in the camera menu under Network → Browser Remote settings).
3. Enter credentials — defaults are **Username: `Full`** / **Password: `12345678`**.
4. Click **Connect**.

Settings are saved in `localStorage` and automatically reconnect on the next page load.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |

---

## Camera Network Setup

On the camera:

1. Go to **Menu → Network → Browser Remote** and enable it.
2. Note the IP address shown on screen (or set a static IP via DHCP reservation).
3. Ensure the camera and the computer running this dashboard are on the same network subnet.

---

## Project Structure

```
.
├── server.js          # Express + WebSocket proxy server
├── package.json
├── public/
│   ├── index.html     # Dashboard UI
│   ├── style.css      # Dark-theme responsive styles
│   └── app.js         # Frontend application logic
└── README.md
```

---

## API Reference (Canon XF)

All endpoints are HTTP GET requests to `http://<camera-ip>/api/cam/`.

| Command | Endpoint |
|---|---|
| Login | `GET /api/acnt/login?uname=<user>&pw=<pass>` |
| Get all properties | `GET /api/cam/getcurprop` |
| Trigger record | `GET /api/cam/rec?cmd=trig` |
| Switch SD slot | `GET /api/cam/rec?cmd=slot` |
| Iris open/close | `GET /api/cam/drivelens?iris=plus\|minus` |
| Set iris value | `GET /api/cam/drivelens?iris=<value>` |
| Auto iris push | `GET /api/cam/drivelens?ai=push` |
| Gain up/down | `GET /api/cam/drivelens?gain=plus\|minus` |
| ND up/down | `GET /api/cam/drivelens?nd=up\|down` |
| Focus adjust | `GET /api/cam/drivelens?fl=<±value>` |
| Toggle AF | `GET /api/cam/drivelens?sw=afmode` |
| AF lock toggle | `GET /api/cam/drivelens?af=togglelock` |
| Zoom | `GET /api/cam/drivelens?zoom=wide\|tele` |
| Step zoom | `GET /api/cam/drivelens?stepzoom=<level>` |
| AWB hold | `GET /api/cam/cmdwb?awbhold=trig` |
| Set WB mode | `GET /api/cam/setprop?wbm=<mode>` |
| Set Kelvin | `GET /api/cam/setprop?wbvk=<value>` |
| Full auto | `GET /api/cam/setprop?fullauto=on\|off` |
| Set shutter mode | `GET /api/cam/setprop?ssm=<mode>` |
| Set gain mode | `GET /api/cam/setprop?gcm=<mode>` |
| Face detection | `GET /api/cam/setprop?fdat=on\|off` |

Authentication uses cookies returned by the login endpoint. The proxy server attaches these cookies to every subsequent request.

---

## Development

```bash
npm install
npm run dev   # uses nodemon for auto-restart
```

The server proxies `/api/*` requests and serves the `public/` directory as static files.

---

## Contributing

Pull requests are welcome. For major changes, please open an issue first.

Please run a quick sanity-check against a real camera (or the Canon simulator if available) before submitting.

---

## Acknowledgements

- API discovery based on the excellent work in [bitfocus/companion-module-canon-xf](https://github.com/bitfocus/companion-module-canon-xf).
- Icons from [Heroicons](https://heroicons.com) (MIT).

---

## License

Copyright (C) 2024 Chris Whitehouse

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License** as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [GNU General Public License](LICENSE) for more details.
