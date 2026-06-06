# PLAN — AnkerMake M5 WiFi File Manager on a Pi Zero 2 W

A plan to add a **browser-based file manager** (view / delete / create folders /
drag-and-drop upload) on top of the existing "Pi-as-USB-stick" setup in this repo,
so you can manage the files your **AnkerMake M5** reads from USB without ever
plugging/unplugging a real stick.

---

## 1. Background — what we already have and how it works

This repo turns a Raspberry Pi Zero (2) W into a **USB mass-storage gadget**:

| Piece | Role |
|-------|------|
| `/piusb.bin` | A 2 GB file, formatted FAT32, that *is* the "USB stick" |
| `g_mass_storage` / `g_multi` kernel gadget | Presents `/piusb.bin` to the printer over the USB **data** port |
| `/mnt/usb_share` | The same image loop-mounted on the Pi so we can read/write its files |
| Samba (`[usb]` share) | Exposes `/mnt/usb_share` on the network as `\\<pi>\usb` |
| `usbshare.py` watchdog (systemd `usbshare.service`) | Watches `/mnt/usb_share`; after a change it **unplugs + replugs** the virtual USB so the printer re-reads the file list |

**Key insight that makes this easy:** anything written into `/mnt/usb_share`
becomes visible to the printer automatically, because the watchdog remounts the
gadget. So the web app does **not** need to know anything about USB gadgets — it
only needs to read and write files in `/mnt/usb_share`. All the hard USB plumbing
is already done.

### AnkerMake M5 specifics (assumptions — verify on first run)
- The M5 has a USB-A port and can **print from a USB drive**; AnkerMake Studio
  produces `.gcode` and `.acode` files. The slicer/app can push a job over WiFi
  for a one-off print but offers **no file management** — exactly the gap we fill.
- The M5 should accept our virtual stick like any FAT32 USB drive. **To verify:**
  whether it lists files in **sub-folders** or only the **root** of the drive. If
  it only reads the root, we keep prints in the root and use folders purely for
  our own organisation/archive. (This affects nothing in the code — just how you
  organise files.)
- FAT32 limits to be aware of: 4 GB max per file (irrelevant for gcode), and the
  image size caps total capacity (2 GB by default — easy to enlarge, see §7).

---

## 2. Goal / requirements

1. Web app reachable from any browser on the LAN (laptop + phone).
2. **List** files and folders, **navigate** into folders (breadcrumb).
3. **Delete** files and folders.
4. **Create** directories.
5. **Upload** via drag-and-drop (and a normal file picker as a fallback).
6. **Download** a file back to the computer (nice-to-have, cheap to add).
7. Starts **automatically on boot**, alongside the USB gadget.
8. Provisioning + management should be **simple** — ideally one script and a
   single self-contained app file.

---

## 3. Design decisions (recommended defaults)

### 3.1 Web app: one self-contained Python file, zero pip dependencies
Use Python's **standard library** (`http.server` + a tiny multipart parser) with
the **HTML/CSS/JS embedded inline** in the same file. Why:

- The Pi already has Python 3 — **nothing to install**, no Flask, no Node, no
  build step. This is the closest thing to your "single file / binary" wish while
  staying trivially editable.
- One file (`webapp.py`) to copy, one systemd service to run it.
- (A true compiled binary via PyInstaller/Nuitka is possible but is pure
  overhead here — a single `.py` is already "one file" and easier to tweak.)

> Alternative if you'd prefer it: a Flask + small static bundle. More familiar to
> some, but adds a dependency and a few more files for no real benefit at this
> scale. **Recommendation: stick with stdlib.**

### 3.2 The web app only touches `/mnt/usb_share`
It never calls `modprobe`. The existing `usbshare.py` watchdog picks up the change
and remounts the gadget. One **refinement** is needed (see §4.3): the current
watchdog only reacts to a subset of events, so a *brand-new empty folder* may not
trigger a remount until a file lands in it. We'll widen the watchdog's event list
(and/or call `sync`) so create/upload/delete all propagate promptly.

### 3.3 Networking / how you reach it
- Install **Avahi (mDNS)** so the Pi is reachable at a friendly name, e.g.
  `http://ankermake.local/` — no need to hunt for the IP.
- Bind the web server to `0.0.0.0`. Use **port 8080** (no root needed) and
  optionally redirect 80→8080, *or* grant the service the capability to bind 80
  via systemd (`AmbientCapabilities=CAP_NET_BIND_SERVICE`). **Recommendation:**
  run on **80** via that capability so the URL is just `http://ankermake.local/`.

### 3.4 Security (it can delete your files)
The app exposes delete/upload, so even on a home LAN add a light guard:
- **HTTP Basic Auth** with a username/password set in the install script
  (stored in an env var read by the service). Simple, good enough for a LAN.
- Keep it **LAN-only** — do **not** port-forward it to the internet.
- Reject path traversal (`..`) on every API call so requests can't escape
  `/mnt/usb_share`.

### 3.5 Safety around the printer
- Briefly remounting the virtual USB is fine while idle, but **avoid file
  operations during an active print** in case the M5 streams from USB rather than
  copying to internal memory. The UI will show a clear warning banner; optionally
  we add a "I'm not printing" confirm on destructive actions. (Cheap, optional.)
- Always `sync` after writes so data is flushed to `/piusb.bin` before the
  gadget is replugged (prevents the printer seeing a half-written file).

---

## 4. Implementation

### 4.1 New web app — `webapp.py` (single file)
A `ThreadingHTTPServer` with these routes:

| Method + path | Purpose |
|---|---|
| `GET /` | Serves the single-page UI (inline HTML/CSS/JS) |
| `GET /api/list?path=<rel>` | JSON: folders + files (name, size, mtime) for that sub-path |
| `POST /api/upload?path=<rel>` | `multipart/form-data`; streams file(s) to disk, then `sync` |
| `POST /api/mkdir` | JSON `{path, name}` → create directory |
| `POST /api/delete` | JSON `{path}` → delete file or folder (recursive for folders) |
| `GET /api/download?path=<rel>` | Stream a file back for download |
| `GET /api/status` | Free space, file count, whether a remount is pending (for the UI) |

Implementation notes:
- **Path safety:** resolve every `path` against `/mnt/usb_share` with
  `os.path.realpath` and reject anything that escapes the root.
- **Streaming upload:** write incoming bytes straight to the target file in
  chunks (don't buffer whole files in RAM — the Zero has little memory).
- **Basic Auth:** check the `Authorization` header against
  credentials from environment (`FM_USER` / `FM_PASS`); return `401` otherwise.
- **`sync` after every mutating op** so `/piusb.bin` is consistent before remount.

### 4.2 Frontend (embedded in `webapp.py`)
Single HTML page, **vanilla JS**, no frameworks:
- Breadcrumb path + folder/file list with size and date.
- **Drag-and-drop zone** over the whole list + a "Choose files" button; upload
  progress bar using `fetch` + `XMLHttpRequest` progress events.
- Buttons: **New folder**, **Delete** (per row, with confirm), **Download**.
- Mobile-friendly CSS so it works from your phone.
- A status bar showing free space and a subtle "syncing to printer…" indicator
  for the few seconds after a change.

### 4.3 Tweak the existing watchdog — `usbshare.py`
Widen `ACT_EVENTS` so **folder creation and new files** also trigger the
unplug/replug cycle (currently it mainly reacts to delete/modify/move):

```python
from watchdog.events import (
    DirCreatedEvent, DirDeletedEvent, DirMovedEvent,
    FileCreatedEvent, FileDeletedEvent, FileModifiedEvent, FileMovedEvent,
)
ACT_EVENTS = [
    DirCreatedEvent, DirDeletedEvent, DirMovedEvent,
    FileCreatedEvent, FileDeletedEvent, FileModifiedEvent, FileMovedEvent,
]
```

This keeps the web app totally decoupled from the USB layer.

### 4.4 New systemd service — `filemanager.service`
```ini
[Unit]
Description=AnkerMake WiFi File Manager (web UI)
After=multi-user.target mnt-usb_share.mount
Wants=usbshare.service

[Service]
Type=simple
Environment=FM_USER=anker
Environment=FM_PASS=changeme            # set during install
Environment=FM_ROOT=/mnt/usb_share
Environment=FM_PORT=80
AmbientCapabilities=CAP_NET_BIND_SERVICE   # allow binding port 80 as non-root
ExecStart=/usr/bin/python3 /usr/local/share/webapp.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
Both services are `WantedBy=multi-user.target`, so on every boot the Pi:
1. brings up WiFi, 2. starts `usbshare.service` (virtual USB auto-connects to the
printer), 3. starts `filemanager.service` (web UI is live). That satisfies
"auto connect on startup over USB and start the web app".

### 4.5 Extend `install.sh`
Add steps to the existing installer (keep it the **one** provisioning script):
1. `apt-get install -y avahi-daemon` (friendly `.local` hostname). Python stdlib
   covers the web app, so **no extra Python packages** are needed.
2. Prompt for a **web username/password** and write them into
   `filemanager.service`.
3. Copy `webapp.py` → `/usr/local/share/webapp.py`.
4. Install + enable + start `filemanager.service`.
5. Print the final URL: `http://<hostname>.local/`.

---

## 5. Provisioning the Pi — the easy path (one-time)

1. **Flash the SD card** with **Raspberry Pi Imager**, choosing *Raspberry Pi OS
   Lite (32-bit)*. In Imager's settings (gear / Ctrl-Shift-X):
   - Set **hostname** (e.g. `ankermake`).
   - **Enable SSH** (password or key).
   - Enter your **WiFi SSID + password** and country.
   - Set username/password.
   This means the Pi joins your WiFi and is reachable headless on first boot — no
   monitor/keyboard needed.
2. **Boot**, then `ssh user@ankermake.local`.
3. Run the installer (the existing one, extended per §4.5):
   ```bash
   sudo apt update && sudo apt install -y git
   git clone https://github.com/garethknowles/rpi-zero-w-wifi-usb.git
   cd rpi-zero-w-wifi-usb
   sudo chmod +x install.sh && sudo ./install.sh
   ```
   (Use `sudo ./install.sh g_mass_storage` if the M5 doesn't like `g_multi` —
   see the repo's Troubleshooting section.)
4. **"Fix" the USB data cable** (tape over the 5 V pin) so the Pi and printer
   don't back-feed power — see README §"Fixing the USB Data Cable". Power the Pi
   from its **own** supply via the **PWR** port; connect the **taped** cable from
   the Pi's **USB/data** port to the printer.
5. Reboot. Visit **`http://ankermake.local/`**, log in, drag a `.gcode`/`.acode`
   file in. Within ~10–15 s it appears on the printer's USB menu.

---

## 6. Ongoing management

- **Everyday use:** the web UI itself is the management surface (upload, organise,
  delete, make folders).
- **Find it:** `http://ankermake.local/` (mDNS). Fallback: check your router for
  the Pi's IP.
- **Admin:** SSH for updates (`git pull` + re-run `install.sh`), logs via
  `journalctl -u filemanager.service` and `journalctl -u usbshare.service`.
- **Optional UI niceties (later):** a "Remount now" button, a "Reboot Pi" button,
  and a free-space gauge — all small additions to `/api/status`.

---

## 7. Capacity, gotchas & risks

- **Drive size:** default image is 2 GB. To resize, recreate `/piusb.bin` with a
  larger `count=` in `dd` and reformat (this **erases** the virtual drive). Leave
  headroom on the SD card.
- **Don't operate during a print:** if the M5 streams from USB, a remount mid-print
  could interrupt it. The UI warns; treat destructive actions as "printer idle"
  operations.
- **Single-writer rule:** write to the drive from **either** the printer **or**
  the Pi at a time — never have the printer writing while the web app writes.
  In practice the M5 only *reads* for printing, so this is rarely an issue.
- **FAT32 quirks:** long filenames are fine; avoid characters illegal on FAT32
  (`\\ / : * ? " < > |`). The app should sanitise upload names.
- **Security:** Basic Auth + LAN-only. Never expose the port to the internet.
- **mDNS on the laptop:** Windows needs Bonjour (often already present via iTunes
  or printer drivers); otherwise use the IP. macOS/Linux work out of the box.

---

## 8. Build checklist / phases

- [ ] **Phase 1 — Web app core:** `webapp.py` with list/upload/mkdir/delete +
      inline UI; run it manually (`FM_ROOT=/tmp/test python3 webapp.py`) and test
      from a browser.
- [ ] **Phase 2 — Drag-and-drop + download + status:** progress bar, download
      route, free-space/status bar, mobile CSS.
- [ ] **Phase 3 — Watchdog tweak:** widen `ACT_EVENTS` in `usbshare.py` so all
      create/upload/delete events trigger a remount.
- [ ] **Phase 4 — Service + install:** add `filemanager.service`, Avahi, and the
      web-app steps to `install.sh`; prompt for web credentials.
- [ ] **Phase 5 — On-Pi validation:** flash, install, attach to the M5, confirm a
      dropped file prints and that delete/mkdir reflect on the printer.
- [ ] **Phase 6 — Docs:** update `README.md` with the web-app section and the
      `http://<hostname>.local/` URL.

---

## 9. Resulting file layout

```
RPi-Zero-W-WiFi-USB/
├── install.sh                 # extended: installs web app + service + avahi
├── usbshare.py                # tweaked: wider event list
├── webapp.py                  # NEW — single-file web file manager (stdlib only)
├── filemanager.service        # NEW — systemd unit for the web app
├── PLAN.md                    # this file
└── README.md                  # updated with web-app instructions
```
