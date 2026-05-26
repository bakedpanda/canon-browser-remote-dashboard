# Canon XF / C-Series Browser Remote API Reference

Firmware: Canon Browser Remote (© Canon 2020)  
Tested camera: 192.168.8.21  
Session: cookie-based (`acid` + `authlevel` + `productId` + `brlang`)

---

## How Commands Are Sent

All communication is plain **HTTP GET** over port 80.  
The dashboard server proxies these — the browser never talks to the camera directly.

**Dashboard → Server:**
```
POST /api/command
{ "camId": "cam1", "cmd": "drivelens?iris=plus" }
```

**Server → Camera:**
```
GET http://192.168.8.21/api/cam/drivelens?iris=plus
Cookie: authlevel=full; productId=VOAX00; brlang=0; acid=XXXX
```

Camera returns `{"res":"ok"}` on success, `{"res":"failparam"}` for bad params,  
`{"res":"busy"}` if a long-poll slot is occupied, `{"res":"errsession"}` if session expired.

---

## Status Polling

The camera uses a **long-poll** mechanism. Only **one** client can hold the slot at a time.

| Endpoint | Behaviour |
|---|---|
| `GET /api/cam/getcurprop?seq=0` | Returns ALL current properties immediately (~2 KB JSON) |
| `GET /api/cam/getcurprop?seq=N` | Holds connection up to ~30 s, returns only **changed** props (delta) |
| `GET /api/cam/getprop?r=PROP` | Returns list of valid values for a single property (for UI pickers) |

**Required headers for `getcurprop`:**
```
If-Modified-Since: Thu, 01 Jun 1970 00:00:00 GMT
Referer: http://192.168.8.21/wpd/VOAX00/rc/advanced.htm
Cookie: authlevel=full; productId=VOAX00; brlang=0; acid=XXXX
```
> ⚠️ Do NOT send `Authorization: Basic` on post-login requests — it opens a competing
> session that grabs the long-poll slot, causing `getcurprop` to return `busy` indefinitely.

---

## Status Properties (from `getcurprop`)

### Recording

| Property path | Type | Values / Notes |
|---|---|---|
| `rec` | string | **Standby:** `Stby`, `stby`, `pre_rec`, `pre_rec_stby`, `frm`, `frm_stby`, `int`, `int_stby`, `sf_off`, `sf_stby` |
| | | **Recording:** `Rec`, `rec`, `pre_rec_rec`, `FrmRec`, `frm_rec`, `IntRec`, `int_rec`, `SFRec`, `sf_rec` |
| `extrec` | string | External record state: `off`, `rec`, `pre_rec_rec` |
| `tc` | string | 8-char timecode `"HHMMSSFF"` e.g. `"01143022"` → 01:14:30:22 |
| `recfmt` | string | `xf-avc`, `hevc`, `mp4`, `non` |

### Recording Resolution, Frame Rate, Bitrate

> **Status:** These properties appear in the `getcurprop` response as `Orecmode` and  
> `Ovconfig` but the camera's Browser Remote UI does not render them (empty callbacks  
> in status.js). Their exact field structure is **unconfirmed** without captured camera data.  
> Once `getcurprop` is working, run `GET /api/status` from the dashboard server to inspect  
> the raw `status` object and find these fields.

Likely candidates based on camera firmware patterns:
- `Orecmode` — probably contains frame rate, scan mode (P/i), recording mode
- `Ovconfig` — probably contains resolution, bit depth, codec config

### Media / Storage

| Property path | Type | Values / Notes |
|---|---|---|
| `Omedia.Osda.state` | string | `n` = no card, `normal` = OK, `protect` = write-protected |
| `Omedia.Osda.select` | int | `1` = this slot is currently active/recording, `0` = inactive |
| `Omedia.Osda.rtime` | int | Remaining record time in **minutes** (`-1` = unknown) |
| `Omedia.Osdb.*` | — | Same structure as Osda |

### Power

| Property path | Type | Values / Notes |
|---|---|---|
| `Opower.Obatt.percent` | string | `"0"`–`"100"` (numeric string), `"non"` = no battery, `"?"` = unknown |
| `Opower.Obatt.rtime` | int or `"non"` | Remaining battery time in **minutes** |

### Iris / Aperture

| Property path | Type | Values / Notes |
|---|---|---|
| `Oirisinfo.Ovalue.pv` | string | Current aperture: `"F1.8"`, `"F5.6"`, `"closeiris"`, `"auto"` |
| `Oirisinfo.Ovalue.en` | int | `1` = adjustable, `0` = locked/unavailable |
| `Oirisinfo.Omode.pv` | string | `"autoiris"` or `"maniris"` |
| `Oirisinfo.Omode.en` | int | `1` = mode switchable |
| `Oirisinfo.Opushai.pv` | string | Push auto iris state: `"run"`, `"stop"` |

### Gain / ISO

| Property path | Type | Values / Notes |
|---|---|---|
| `Oisogaininfo.Ovalue.pv` | string | Current value: `"0dB"`, `"6dB"`, `"800"` (ISO), etc. |
| `Oisogaininfo.Ovalue.en` | int | `1` = adjustable |
| `Oisogaininfo.Omode.pv` | string | `"autogain"`, `"manualgain"`, `"iso"` |
| `Oisogaininfo.Ostep.pv` | string | Step size: `"normal"`, `"fine"`, `"1/3"`, `"1/4"` |

### Shutter

| Property path | Type | Values / Notes |
|---|---|---|
| `Oshutterinfo.Ovalue.pv` | string | Current value: `"1/100"`, `"180"` (angle in °), `"59.94"` (CLS Hz) |
| `Oshutterinfo.Ovalue.en` | int | `1` = adjustable |
| `Oshutterinfo.Omode.pv` | string | `"speed"` (1/N), `"angle"` (°), `"cls"` (clear scan Hz), `"slow"`, `"auto"`, `"off"` |
| `Oshutterinfo.Ostep.pv` | string | Step size within mode |

### ND Filter

| Property path | Type | Values / Notes |
|---|---|---|
| `Ondinfo.Ovalue.pv` | string | `"off"`, `"1/4"`, `"1/16"`, `"1/64"` (camera-dependent range) |
| `Ondinfo.Ovalue.en` | int | `1` = adjustable |
| `Ondinfo.adjen` | int | `1` = ND adjustment enabled |

### AES (Exposure Shift / Auto Exposure Shift)

| Property path | Type | Values / Notes |
|---|---|---|
| `Oaesinfo.Ovalue.pv` | string | e.g. `"-2"`, `"-1"`, `"0"`, `"+1"`, `"+2"`, `"--"` (unavailable) |
| `Oaesinfo.Ovalue.en` | int | `1` = adjustable |

### White Balance

| Property path | Type | Values / Notes |
|---|---|---|
| `Owbinfo.Omode.pv` | string | `"awb"`, `"seta"`, `"setb"`, `"daylight"`, `"tungsten"`, `"kelvin"` |
| `Owbinfo.Omode.en` | int | `1` = mode switchable |
| `Owbinfo.Oawbhold.pv` | string | AWB hold state: `"on"`, `"off"` |
| `Owbinfo.Oseta.Ovalue.kelvinvalue` | string | Set A colour temp |
| `Owbinfo.Oseta.Ovalue.ccvalue` | string | Set A CC value |
| `Owbinfo.Osetb.*` | — | Same as Oseta |
| `Owbinfo.Okelvin.kelvinvalue` | string | Kelvin value when in kelvin mode |

### Focus / AF

| Property path | Type | Values / Notes |
|---|---|---|
| `Ofocusinfo.Oafmode.pv` | string | `"continuous"` = AF on, `"off"` = manual focus |
| `Ofocusinfo.Oafmode.en` | int | `1` = AF mode switchable |
| `Ofocusinfo.Ofacedat.pv` | string | Face detect: `"on"`, `"off"`, `"non"` (unavailable) |
| `Ofocusinfo.Ofguide.pv` | string | Focus guide: `"on"`, `"off"`, `"non"` |
| `Ofocusinfo.Ofctrl.pv` | string | Focus control position: `"near3"`, `"near2"`, `"near1"`, `""`, `"far1"`, `"far2"`, `"far3"` |
| `Ofocusinfo.trctrlen` | int | AF tracking control: `0` = disabled, `2` = enabled |
| `Ofocusinfo.tcctrlen` | int | Track cancel: `0` = disabled |

### Zoom

| Property path | Type | Values / Notes |
|---|---|---|
| `Ozoom.pos` | int | Current zoom position `0` (wide) – `100` (tele) |
| `Ozoom.status` | string | `"run"` (zooming), `"stop"` (stationary) |
| `Ozoom.speed` | int | Current zoom speed |

### Other

| Property path | Type | Values / Notes |
|---|---|---|
| `Ofullauto.pv` | string | `"on"` or `"off"` |
| `Ofullauto.en` | int | `1` = full auto toggleable |
| `irmode` | string | IR mode: `"off"` or mode string |
| `camid` | string | Camera ID string (shown in multi-cam UI) |
| `mode` | string | `"nonctrl"` = camera is not controllable |

---

## Commands

All commands go to `/api/cam/COMMAND?PARAMS`.  
From the dashboard, send: `POST /api/command { camId, cmd: "COMMAND?PARAMS" }`.

### Recording

| Command | Description |
|---|---|
| `rec?cmd=trig` | Toggle record start/stop |
| `rec?cmd=slot` | Switch active SD card slot |
| `markclip?type=ok` | Mark clip OK |
| `markclip?type=check` | Mark clip CHECK |
| `markclip?type=shot1` | Mark clip SHOT |

### Iris

| Command | Description |
|---|---|
| `drivelens?iris=plus` | Open iris (lower f-stop) |
| `drivelens?iris=minus` | Close iris (higher f-stop) |
| `setprop?am=autoiris` | Switch to auto iris mode |
| `setprop?am=maniris` | Switch to manual iris mode |
| `drivelens?ai=push` | Push auto iris (one-shot AF on iris) |

### Gain / ISO

| Command | Description |
|---|---|
| `drivelens?gain=plus` | Increase gain |
| `drivelens?gain=minus` | Decrease gain |
| `drivelens?iso=plus` | Increase ISO (when in ISO mode) |
| `drivelens?iso=minus` | Decrease ISO |

### Shutter

| Command | Description |
|---|---|
| `drivelens?shutter=plus` | Increase shutter (faster speed, larger angle) |
| `drivelens?shutter=minus` | Decrease shutter (slower speed, smaller angle) |
| `setprop?ssm=speed` | Switch to speed mode (1/N) |
| `setprop?ssm=angle` | Switch to angle mode (degrees) |
| `setprop?ssm=cls` | Switch to clear scan mode (Hz) |
| `setprop?ssm=slow` | Switch to slow shutter mode |
| `setprop?ssm=auto` | Switch to auto shutter mode |
| `setprop?ssm=off` | Shutter off |

### ND Filter

| Command | Description |
|---|---|
| `drivelens?nd=plus` | Increase ND density |
| `drivelens?nd=minus` | Decrease ND density |

### AES (Exposure Shift)

| Command | Description |
|---|---|
| `drivelens?aes=plus` | Increase exposure shift |
| `drivelens?aes=minus` | Decrease exposure shift |

### White Balance

| Command | Description |
|---|---|
| `setprop?wbm=awb` | Auto white balance |
| `setprop?wbm=seta` | WB Set A |
| `setprop?wbm=setb` | WB Set B |
| `setprop?wbm=daylight` | Daylight preset |
| `setprop?wbm=tungsten` | Tungsten preset |
| `setprop?wbm=kelvin` | Kelvin mode |
| `cmdwb?awbhold=trig` | Toggle AWB hold |
| `cmdwb?wbset=a` | Execute WB Set A (store current WB as Set A) |
| `cmdwb?wbset=b` | Execute WB Set B |

### Focus

Focus buttons use **3 speed levels** — 1 = fine, 2 = medium, 3 = coarse.  
For a **tap** (single step): send without `start` suffix.  
For **hold** (continuous move): send with `start` on mousedown, `stop` on mouseup.

| Command | Description |
|---|---|
| `drivelens?fl=near1` | Focus near — fine step (tap) |
| `drivelens?fl=near2` | Focus near — medium step (tap) |
| `drivelens?fl=near3` | Focus near — coarse step (tap) |
| `drivelens?fl=far1` | Focus far — fine step (tap) |
| `drivelens?fl=far2` | Focus far — medium step (tap) |
| `drivelens?fl=far3` | Focus far — coarse step (tap) |
| `drivelens?fl=near1start` | Begin continuous near focus (fine) — hold |
| `drivelens?fl=near1stop` | Stop continuous near focus |
| `drivelens?fl=far1start` | Begin continuous far focus (fine) — hold |
| `drivelens?fl=far1stop` | Stop continuous far focus |
| `drivelens?focus=track` | Start AF tracking |
| `drivelens?focus=trackcancel` | Cancel AF tracking |

### Zoom

Continuous zoom: send command to start, send again (or button release) to stop.  
Step zoom: instantly moves to one of 6 preset positions (0%, 20%, 40%, 60%, 80%, 100%).

| Command | Description |
|---|---|
| `drivelens?zoom=tele1` | Zoom tele (continuous, speed 1) |
| `drivelens?zoom=wide1` | Zoom wide (continuous, speed 1) |
| `drivelens?stepzoom=1` | Step zoom to position 1 (~0% / wide end) |
| `drivelens?stepzoom=2` | Step zoom to position 2 (~20%) |
| `drivelens?stepzoom=3` | Step zoom to position 3 (~40%) |
| `drivelens?stepzoom=4` | Step zoom to position 4 (~60%) |
| `drivelens?stepzoom=5` | Step zoom to position 5 (~80%) |
| `drivelens?stepzoom=6` | Step zoom to position 6 (~100% / tele end) |

### Full Auto

| Command | Description |
|---|---|
| `setprop?fullauto=on` | Enable full auto mode |
| `setprop?fullauto=off` | Disable full auto mode |

---

## Session / Auth

| Endpoint | Method | Description |
|---|---|---|
| `/api/acnt/login?uname=Full&pw=12345678` | POST | Log in, returns `acid` + `authlevel` cookies |
| `/api/acnt/logout` | POST | Log out, clears session |

Login response cookies: `acid=XXXX; authlevel=full`  
Root page sets (via JS): `productId=VOAX00; brlang=0`  
All four must be present in the `Cookie` header for `getcurprop` to work.

---

## Dashboard Server Endpoints

| Endpoint | Description |
|---|---|
| `POST /api/connect` | Connect a camera slot |
| `POST /api/disconnect` | Disconnect a camera slot |
| `POST /api/command` | Send a command to a camera |
| `GET /api/status` | Raw status JSON for all cameras |
| `GET /api/rawstatus/:camId` | Direct getcurprop probe |
| `GET /api/probe/:camId` | Try all known status endpoints, show results |
| `GET /api/camfetch/:camId?path=` | Proxy-fetch any path from camera (text) |
| `GET /companion/status` | Companion-friendly flat status |
| `POST /companion/command` | Companion command relay |
| `WS ws://host:8847` | Live status updates, also accepts `{type:"command"}` |

---

## Notes & Limitations

- The camera allows **only one Browser Remote session** at a time. Connecting from a browser tab (192.168.8.21) or Companion simultaneously will cause `busy` / `errsession`.
- Recording resolution, frame rate, and bitrate are **not exposed** by the Browser Remote API in any confirmed field. They may appear in `Orecmode` / `Ovconfig` but require live data to confirm.
- The `getprop?r=PROPERTY` endpoint returns the list of selectable values for a given property. This is used by the camera's own UI for picker panels but not yet used by this dashboard.
- Shutter `angle` mode values are in degrees (e.g. `"180"`, `"90"`, `"45"`). The `shutter=plus/minus` commands step through valid values in the current mode.
- Focus and zoom buttons in the Browser Remote are **held controls** — the camera expects a `start` request on press and a `stop` request on release. The dashboard currently sends tap commands; for smooth continuous movement, hold-start/stop behaviour should be implemented.
