# PLAN — AnkerMake M5 WiFi File Manager on a Pi Zero 2 W (TypeScript / Bun)

A plan to add a **browser-based file manager** (view / delete / create folders /
drag-and-drop upload) on top of this repo's existing "Pi-as-USB-stick" setup, so
you can manage the files your **AnkerMake M5** reads from USB without ever
plugging/unplugging a real stick.

**Stack:** A single **TypeScript** app run on **[Bun](https://bun.sh)**. One
process does everything — serves the web UI **and** replaces the Python
`usbshare.py` watchdog — and compiles to a **single standalone binary**. No
Python, no Node build chain, one systemd service.

---

## 1. Background — what we already have and how it works

This repo turns a Raspberry Pi Zero (2) W into a **USB mass-storage gadget**:

| Piece | Role |
|-------|------|
| `/piusb.bin` | A ~50 GB file, formatted FAT32, that *is* the "USB stick" |
| `g_mass_storage` / `g_multi` kernel gadget | Presents `/piusb.bin` to the printer over the USB **data** port |
| `/mnt/usb_share` | The same image loop-mounted on the Pi so we can read/write its files |
| Samba (`[usb]` share) | Exposes `/mnt/usb_share` on the network as `\\<pi>\usb` |
| `usbshare.py` watchdog (systemd `usbshare.service`) | Watches `/mnt/usb_share`; after a change it **unplugs + replugs** the virtual USB so the printer re-reads the file list |

**Key insight that makes this easy:** anything written into `/mnt/usb_share`
becomes visible to the printer after the gadget is "replugged"
(`modprobe -r` then `modprobe`). The USB plumbing (`dd`/`mkdosfs` image, `dwc2`
overlay, fstab loop-mount, Samba) is **already done by `install.sh`** and we keep
all of it. What we change is the **software layer on top**: one Bun/TypeScript
program that serves the web UI, watches the folder, and does the replug.

### AnkerMake M5 specifics (assumptions — verify on first run)
- The M5 has a USB-A port and can **print from a USB drive**; AnkerMake Studio
  produces `.gcode` and `.acode` files. The app/slicer can push a one-off job over
  WiFi but offers **no file management** — exactly the gap we fill.
- The M5 should accept our virtual stick like any FAT32 USB drive. **To verify:**
  whether it lists files in **sub-folders** or only the **root** of the drive.
  This changes nothing in the code — only how you organise files.
- FAT32 limits: 4 GB max per file (irrelevant for gcode); total capacity is the
  image size — we'll default this to **~50 GB** (see §7), so you'll want a
  **64 GB or larger SD card**.

---

## 2. Goal / requirements

1. Web app reachable from any browser on the LAN (laptop + phone).
2. **List** files/folders and **navigate** into folders (breadcrumb).
3. **Delete** files and folders.
4. **Create** directories.
5. **Upload** via drag-and-drop (+ a normal file picker fallback).
6. **Download** a file back to the computer (nice-to-have, cheap).
7. Starts **automatically on boot**, with the USB gadget.
8. Provisioning + management should be **simple** — one install script, one
   self-contained binary.

---

## 3. Why Bun, and the one prerequisite

- **TypeScript with no build step.** Bun runs `.ts` directly (`bun run app.ts`)
  and can also produce a **single standalone executable** (`bun build --compile`)
  — the closest thing to your "single file / binary" wish.
- **Batteries included:** `Bun.serve()` for HTTP, `node:fs`/`node:child_process`
  for filesystem + running `modprobe`. Minimal/zero npm dependencies.
- **One prerequisite — a 64-bit OS.** Bun ships only **64-bit ARM (aarch64)**
  Linux builds, so we must use **Raspberry Pi OS Lite (64-bit)** instead of the
  32-bit version the README currently recommends. The **Pi Zero 2 W is 64-bit
  capable**, so this is fine. *(The original Zero W v1 is not — Bun would not be
  an option there; you'd fall back to Node or stay on Python.)*

> The USB-gadget setup (`dwc2`, `g_mass_storage`, loop-mount, Samba) works the
> same on 64-bit Raspberry Pi OS. `install.sh` already handles the
> `/boot/firmware` path used by current images.

---

## 4. Architecture — one Bun process replaces two things

The single app (`ankermanager.ts`) merges the **web server** and the **USB
watchdog**, so `usbshare.py` and its service are **removed**:

```
            ┌──────────────────────────────────────────────┐
  browser ──┤  Bun HTTP server  (web UI + JSON API)         │
 (LAN/WiFi) │     writes/reads ──► /mnt/usb_share           │
            │                                               │
            │  fs watcher on /mnt/usb_share ──┐             │
            │     (debounced 5s)              ▼             │
            │  replug: modprobe -r g_mass_storage; sync;    │
            │          modprobe g_mass_storage file=…       │
            └───────────────────┬──────────────────────────┘
                                ▼
                       virtual USB ──► AnkerMake M5
```

- **Two triggers for a replug:**
  1. The app's own mutations (upload/delete/mkdir) call the replug **directly**
     after `sync` → fast, deterministic feedback.
  2. An **fs watcher** on `/mnt/usb_share` catches changes made **outside** the
     web app — e.g. saving a g-code file straight to the Samba network drive from
     your slicer — and replugs after a 5 s debounce (same behaviour as the
     current `usbshare.py`).
- **Single-flight + debounce:** never run overlapping `modprobe` calls; coalesce
  rapid changes into one replug. `sync` always runs before the replug so the
  printer never sees a half-written `/piusb.bin`.

---

## 5. Implementation

### 5.1 `ankermanager.ts` — the whole app (one file)
HTTP via `Bun.serve()`; routes:

| Method + path | Purpose |
|---|---|
| `GET /` | Single-page UI (HTML/CSS/JS, inlined or a tiny bundled asset) |
| `GET /api/list?path=<rel>` | JSON: folders + files (name, size, mtime) |
| `POST /api/upload?path=<rel>` | Streams uploaded file(s) to disk, `sync`, replug |
| `POST /api/mkdir` | `{path,name}` → create directory, replug |
| `POST /api/delete` | `{path}` → delete file/folder (recursive), replug |
| `GET /api/download?path=<rel>` | Stream a file back for download |
| `GET /api/status` | Free space, file count, replug-in-progress flag |

Internals:
- **Path safety:** resolve every `path` under `FM_ROOT` (`/mnt/usb_share`) with
  `path.resolve` + a prefix check; reject anything escaping the root (`..`).
- **Streaming upload:** write `Request` body straight to disk via Bun's streaming
  APIs — don't buffer whole files in RAM (the Zero 2 W has 512 MB).
- **Replug module:** a small `replug()` that runs
  `modprobe -r g_mass_storage` → `sync` → `modprobe g_mass_storage file=/piusb.bin stall=0 removable=1`,
  guarded by a mutex + debounce. Driver name read from `FM_DRIVER`
  (`g_mass_storage` default; `g_multi` selectable, mirroring the current installer).
- **Watcher:** watch `FM_ROOT` for changes from the Samba path. Node/Bun
  `fs.watch` is **not reliably recursive on Linux**, so use a small, well-tested
  watcher (**chokidar**, which Bun bundles into the compiled binary) **or** a
  lightweight periodic mtime-tree scan. Either way it feeds the same debounced
  `replug()`.
- **Auth:** HTTP Basic Auth checked against `FM_USER` / `FM_PASS` env vars; `401`
  otherwise. LAN-only — never expose to the internet.

### 5.2 Frontend (served by the app)
Single HTML page, **vanilla TS/JS**, no framework:
- Breadcrumb path + folder/file list (size, date).
- **Drag-and-drop zone** over the list + a "Choose files" button; upload progress
  via `fetch`/`XMLHttpRequest` progress events.
- Buttons: **New folder**, **Delete** (per row, confirm), **Download**.
- Mobile-friendly CSS (use it from your phone).
- Status bar: free space + a subtle "syncing to printer…" indicator during a
  replug.

### 5.3 Build & run
- **Dev:** `bun run ankermanager.ts` (no build step).
- **Deploy:** `bun build ankermanager.ts --compile --outfile ankermanager`
  → a single self-contained binary at `/usr/local/bin/ankermanager`.
  *(Alternatively just run the `.ts` with `bun` — both are "one file"; the
  compiled binary removes even the runtime dependency at run time.)*

### 5.4 systemd service — `ankermanager.service` (replaces `usbshare.service`)
```ini
[Unit]
Description=AnkerMake WiFi File Manager (web UI + USB replug)
After=multi-user.target mnt-usb_share.mount
Requires=mnt-usb_share.mount

[Service]
Type=simple
Environment=FM_ROOT=/mnt/usb_share
Environment=FM_PORT=80
Environment=FM_DRIVER=g_mass_storage
Environment=FM_USER=anker
Environment=FM_PASS=changeme            # set during install
AmbientCapabilities=CAP_NET_BIND_SERVICE   # bind port 80 without full root
ExecStart=/usr/local/bin/ankermanager
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
- Runs `modprobe`, so the unit needs the privilege to load modules — run as root
  (or grant `CAP_SYS_MODULE`). On boot the Pi: brings up WiFi → mounts
  `/mnt/usb_share` → starts `ankermanager` → virtual USB is connected to the
  printer **and** the web UI is live. That covers "auto-connect over USB + start
  the web app on startup".

### 5.5 Networking
- Install **Avahi (mDNS)** → reach it at **`http://ankermake.local/`** (no IP
  hunting). Bind the server to `0.0.0.0`, port **80** (via the capability above).

### 5.6 Keep the shell scripts simple and readable
All the heavy logic lives in the TypeScript app, so the bash should stay **thin
and obvious** — a glue layer anyone can read top-to-bottom:
- **Linear and commented:** each step prints what it's doing (`echo "==> …"`); no
  clever one-liners or deep nesting. Plain `if`/`for`, no associative-array tricks.
- **Small focused helpers:** keep the existing tidy helpers like
  `append_text_to_file`; add equally small ones (e.g. `ensure_usb_image`,
  `install_bun`, `install_service`) rather than one giant block.
- **Idempotent:** safe to re-run — check "does this already exist?" before
  creating/appending (the current script already does this for fstab/Samba/etc.).
- **`set -euo pipefail`** at the top so failures stop early instead of cascading.
- **One knob at the top:** keep config as named variables at the top of the file
  (e.g. `USB_FILE_SIZE_GB=50`, `WEB_USER`, `WEB_PORT`, `DRIVER`), so changing the
  drive size or port is a one-line edit.
- **No magic:** prefer `truncate -s "${USB_FILE_SIZE_GB}G"` with a clear comment
  over an opaque `dd` incantation.

---

## 6. Provisioning the Pi — the easy path (one-time)

1. **Flash** the SD card with **Raspberry Pi Imager**, choosing **Raspberry Pi OS
   Lite (64-bit)**. In Imager's settings (Ctrl-Shift-X): set **hostname**
   (`ankermake`), **enable SSH**, enter **WiFi SSID + password + country**, set
   user/password. → headless, joins WiFi on first boot.
2. **Boot**, then `ssh user@ankermake.local`.
3. Run the (extended) installer:
   ```bash
   sudo apt update && sudo apt install -y git
   git clone https://github.com/garethknowles/rpi-zero-w-wifi-usb.git
   cd rpi-zero-w-wifi-usb
   sudo chmod +x install.sh && sudo ./install.sh
   ```
   The script will: do the existing USB/Samba setup, **install Bun**
   (`curl -fsSL https://bun.sh/install | bash`), **build** `ankermanager` to
   `/usr/local/bin`, prompt for the **web username/password**, install
   **Avahi**, and enable **`ankermanager.service`** (instead of the old
   Python `usbshare.service`).
4. **"Fix" the USB data cable** (tape the 5 V pin) so the Pi and printer don't
   back-feed power — README §"Fixing the USB Data Cable". Power the Pi from its
   **own** supply (PWR port); connect the **taped** cable from the Pi's
   **USB/data** port to the printer.
5. Reboot → visit **`http://ankermake.local/`**, log in, drag a `.gcode`/`.acode`
   in. Within ~10–15 s it appears on the printer's USB menu.

---

## 7. Capacity, gotchas & risks

- **Drive size (~50 GB):** the image defaults to **50 GB**. Create it **sparse**
  so it doesn't take 50 GB on the SD card up front and isn't slow to make —
  `truncate -s 50G /piusb.bin` (instantly allocates a sparse file that only
  consumes space as files are added) instead of `dd`-ing 50 GB of zeros. Then
  `mkdosfs /piusb.bin -F 32 -I`. Use a **64 GB+ SD card** and keep a few GB of
  headroom for the OS. To resize later, recreate + reformat (this **erases** the
  virtual drive). Note FAT32's 4 GB-per-file cap still applies (fine for gcode).
- **Don't operate during a print:** if the M5 streams from USB, a replug mid-print
  could interrupt it. The UI warns; treat destructive actions as "printer idle".
- **Single-writer rule:** write from **either** the printer **or** the Pi at a
  time. In practice the M5 only *reads* to print, so this is rarely an issue.
- **FAT32 quirks:** long names fine; sanitise upload names to avoid
  `\\ / : * ? " < > |`.
- **Memory:** Bun is heavier than the old Python stdlib server but comfortable on
  the Zero 2 W's 512 MB. (Run the service with a modest `MemoryMax` if desired.)
- **Driver fallback:** if the M5 dislikes `g_multi`, set `FM_DRIVER=g_mass_storage`
  (the default here) — mirrors the repo's existing troubleshooting note.
- **Security:** Basic Auth + LAN-only. Never port-forward it.
- **mDNS on Windows:** needs Bonjour (often already present); else use the IP.

---

## 8. Build checklist / phases

- [ ] **Phase 1 — App core:** `ankermanager.ts` with `Bun.serve` + list/upload/
      mkdir/delete and the inline UI; run locally with `FM_ROOT=/tmp/test bun run
      ankermanager.ts` and test in a browser.
- [ ] **Phase 2 — Replug + watcher:** debounced single-flight `replug()`; trigger
      on app mutations **and** on external (Samba) changes via chokidar/polling.
- [ ] **Phase 3 — UX:** drag-and-drop + progress, download route,
      free-space/status bar, mobile CSS, print-safety warning.
- [ ] **Phase 4 — Service + install:** extend `install.sh` (kept **simple,
      linear, idempotent bash** per §5.6) — default the image to **50 GB sparse**,
      install Bun, `bun build --compile`, install `ankermanager.service` + Avahi,
      prompt for credentials; **remove** `usbshare.py` + `usbshare.service`.
- [ ] **Phase 5 — On-Pi validation:** flash 64-bit OS, install, attach to the M5,
      confirm a dropped file prints and that delete/mkdir reflect on the printer,
      and that a Samba-saved file also triggers a replug.
- [ ] **Phase 6 — Docs:** update `README.md` (64-bit OS note, web-app section,
      `http://<hostname>.local/` URL, remove Python steps).

---

## 9. Resulting file layout

```
RPi-Zero-W-WiFi-USB/
├── install.sh                 # extended: USB/Samba + Bun + build + service + avahi
├── ankermanager.ts            # NEW — single-file TS app (web UI + USB replug)
├── ankermanager.service       # NEW — systemd unit (replaces usbshare.service)
├── package.json               # NEW — Bun deps (e.g. chokidar) + build script
├── PLAN.md                    # this file
├── README.md                  # updated for Bun / 64-bit OS
└── usbshare.py / .service     # REMOVED (folded into ankermanager.ts)
```
