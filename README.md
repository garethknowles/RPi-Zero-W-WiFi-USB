# RPi Zero W WiFi USB — with a web file manager

Turn a Raspberry Pi Zero 2 W into a **virtual USB drive for your 3D printer**
that you manage over WiFi from a **browser**: list, upload (drag & drop), create
folders and delete files — without ever plugging/unplugging a real USB stick.

Originally built for printers that only read from USB (e.g. the **AnkerMake M5**,
which has no proper file management of its own). The Pi pretends to be a USB
stick; you drop a `.gcode`/`.acode` file in the web UI, and a few seconds later
it shows up on the printer.

> **DISCLAIMER:** Use at your own risk. This worked for the authors, but it may
> not work for you, and you are responsible for any damage to your hardware
> (Pi or printer).

---

## How it works

| Piece | Role |
|-------|------|
| `/piusb.bin` | A large (default **50 GB**, sparse) file, formatted **FAT32**, that *is* the "USB stick" |
| `g_mass_storage` USB gadget | Presents `/piusb.bin` to the printer over the Pi's micro-USB **data** port |
| `/mnt/usb_share` | The same image loop-mounted on the Pi so files can be read/written |
| **`ankermanager`** | A single self-contained app (TypeScript, built with [Bun](https://bun.sh)) that serves the **web UI** *and* "replugs" the virtual USB whenever files change, so the printer re-reads them |
| Samba `[usb]` share | Optional: also exposes `/mnt/usb_share` as a network drive (`\\<pi>\usb`) |

`ankermanager` replaces the older Python watchdog — it's one binary, one systemd
service, no Python. See [`PLAN.md`](PLAN.md) for the full design and rationale.

---

## Bill of Materials

- **Raspberry Pi Zero 2 W** (the 64-bit quad-core model — see the note below)
- A **64 GB or larger** micro-SD card (for a 50 GB virtual drive)
- Power supply for the Pi
- A cable to connect the Pi to your printer:
  - **AnkerMake M5:** its media port is **USB-C** (no USB-A, no SD slot), so you
    need a **USB-C → micro-USB** cable, from the printer to the Pi's **data**
    (inner, "USB") micro-USB port. See [Connecting to the printer](#connecting-to-the-printer).
- Optional: a Pi Zero case

> **Why a Zero 2 W and 64-bit OS?** `ankermanager` runs on Bun, which only ships
> 64-bit-ARM Linux builds. The Zero 2 W is 64-bit capable; flash **Raspberry Pi
> OS Lite (64-bit)**. (The original single-core Zero W v1 is 32-bit only and is
> not supported by this version.)

---

## Setup

### 1. Flash the SD card

Use **Raspberry Pi Imager** and choose **Raspberry Pi OS Lite (64-bit)**.
In Imager's advanced settings (the gear icon / `Ctrl+Shift+X`):

- Set a **hostname** (e.g. `ankermake`)
- **Enable SSH**
- Enter your **WiFi SSID + password** and country
- Set a username/password

Boot the Pi, then connect over SSH:

```bash
ssh <user>@ankermake.local
```

### 2. Run the installer

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/garethknowles/rpi-zero-w-wifi-usb.git
cd rpi-zero-w-wifi-usb
sudo ./install.sh
```

The script will:

1. Install packages (Samba, Avahi/mDNS, dosfstools).
2. Enable the USB gadget driver (`dwc2`).
3. Create the **50 GB sparse** FAT32 image and loop-mount it at `/mnt/usb_share`.
4. Configure the optional Samba share.
5. Install **Bun** and build the `ankermanager` binary to `/usr/local/bin`.
6. Prompt you for a **web username/password**.
7. Install and start **`ankermanager.service`** (auto-starts on every boot).

If your printer doesn't like the default gadget, re-run with the composite
driver: `sudo ./install.sh g_multi` (see [Troubleshooting](#troubleshooting)).

> **Tip — keep an SSH-over-USB escape hatch.** Passing `g_multi` makes the Pi
> present **mass storage + a USB ethernet adapter + a serial console** all at
> once. The ethernet adapter means you can SSH into the Pi over the USB cable
> even when WiFi is misbehaving — invaluable for debugging. The tradeoff is
> some printers refuse the composite gadget; if yours does, fall back to the
> default `g_mass_storage`.

### 3. Connect to the printer

The Pi presents itself as a USB **device** through its **micro-USB data port**
(the inner port, often labelled **USB** — *not* **PWR**). Your printer's port is
the **host**.

- **AnkerMake M5 (USB-C host):** use a **USB-C → micro-USB** cable from the
  printer's USB-C port to the Pi's **USB** (data) port.
- **Power:** power the Pi from its **own** supply via the **PWR** port. To stop
  the printer and the Pi's supply both feeding 5 V down the data cable, use a
  **data cable with the 5 V (VBUS) line disconnected** — the equivalent of the
  classic [tape-the-5V-pin trick](https://community.octoprint.org/t/put-tape-on-the-5v-pin-why-and-how/13574).
  Do **not** assume the printer's USB-C port can cleanly power the Pi.

### 4. Reboot and use it

After the installer reboots the Pi, open:

```
http://ankermake.local/      (or http://<pi-ip>/)
```

Log in, then **drag & drop** a `.gcode`/`.acode` file. Within ~10–15 seconds it
appears on the printer's USB menu.

> **AnkerMake M5 note:** keep printable files in the **root** of the drive — the
> M5 may not browse sub-folders. Use folders only for your own archiving, and
> avoid changing files during an active print.

---

## The web UI

- **List & browse** files and folders (breadcrumb navigation).
- **Upload** by drag & drop or the Upload button (with a progress bar).
- **New folder** and **Delete** (files or whole folders).
- **Download** a file back to your computer.
- A status bar shows free space and a "syncing to printer…" indicator after a
  change.

It's protected by HTTP Basic Auth (set during install). **Keep it on your LAN —
do not port-forward it to the internet.**

### Configuration

Settings live in `/etc/ankermanager.env` (read by the systemd service):

| Variable | Default | Meaning |
|----------|---------|---------|
| `FM_ROOT` | `/mnt/usb_share` | Folder the app manages |
| `FM_PORT` | `80` | Web UI port |
| `FM_DRIVER` | `g_mass_storage` | USB gadget driver (`g_mass_storage` or `g_multi`) |
| `FM_USB_IMAGE` | `/piusb.bin` | The FAT32 image file |
| `FM_USER` / `FM_PASS` | — | Web login (empty `FM_USER` disables auth) |
| `FM_DEBOUNCE_MS` | `5000` | Wait after a change before replugging the USB |

After editing it: `sudo systemctl restart ankermanager`.

Logs: `journalctl -u ankermanager -f`

---

## Troubleshooting

### Files don't appear on the printer
Some printers reject the composite `g_multi` gadget (which also exposes
Ethernet/serial). Watch `sudo dmesg -w` while plugged in; if you see the device
repeatedly re-enumerating ("new device is full-speed" on a loop), switch to the
plain mass-storage gadget:

```bash
sudo ./install.sh g_mass_storage   # this is already the default
```

`g_mass_storage` presents a single, standard USB stick and is the most
compatible choice.

### Resize the virtual drive
Stop the service, remove `/piusb.bin`, edit `USB_SIZE_GB` at the top of
`install.sh`, and re-run it (this **erases** the virtual drive). Keep some free
space on the SD card. Note FAT32's 4 GB-per-file limit (irrelevant for gcode).

### Reach it by name
The installer sets up Avahi/mDNS so `http://<hostname>.local/` works. On Windows
this needs Bonjour (often already installed); otherwise use the Pi's IP address.

---

## Credits

Builds on the original "Pi as a WiFi USB drive" project, replacing the Python
watchdog with a single TypeScript/Bun app that adds the browser-based file
manager. See [`PLAN.md`](PLAN.md) for the design.
