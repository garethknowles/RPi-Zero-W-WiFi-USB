#!/usr/bin/env bash
#
# install.sh — set up a Raspberry Pi Zero 2 W as a WiFi-managed USB drive for an
# AnkerMake M5 (or similar USB-stick printer).
#
# It does the OS-level plumbing (USB gadget, FAT32 image, Samba) and installs the
# single "ankermanager" app, which serves the web UI and replugs the USB gadget.
#
# Usage:
#   sudo ./install.sh            # default, presents a plain USB stick (g_mass_storage)
#   sudo ./install.sh g_multi    # use the composite g_multi gadget instead
#
# Re-running is safe: every step checks before it changes anything.

set -euo pipefail

# ----- Configuration (edit these if you like) ------------------------------
USB_IMAGE="/piusb.bin"            # the file that *is* the virtual USB stick
USB_SIZE_GB=50                    # virtual drive size (created sparse, so it
                                  #   only uses real SD space as files are added)
MOUNT_DIR="/mnt/usb_share"        # where the image is loop-mounted on the Pi
WEB_PORT=80                       # web UI port
DRIVER="${1:-g_mass_storage}"     # USB gadget driver (g_mass_storage or g_multi)
APP_BIN="/usr/local/bin/ankermanager"
ENV_FILE="/etc/ankermanager.env"
SERVICE="/etc/systemd/system/ankermanager.service"
BUN_INSTALL_DIR="/usr/local"      # bun lands in $BUN_INSTALL_DIR/bin/bun

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----- Small helpers -------------------------------------------------------
msg()  { echo -e "\n==> $*"; }
warn() { echo "    ! $*" >&2; }

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Please run with sudo: sudo ./install.sh" >&2
    exit 1
  fi
}

# Append a line to a file only if it isn't already there.
append_once() {
  local line="$1" file="$2"
  if ! grep -qxF "$line" "$file" 2>/dev/null; then
    echo "$line" >> "$file"
    echo "    added to $file: $line"
  fi
}

# ----- Steps ---------------------------------------------------------------
install_packages() {
  msg "Installing packages (samba, avahi, dosfstools, curl, unzip)"
  apt-get update
  apt-get install -y samba samba-common-bin avahi-daemon dosfstools curl unzip
}

enable_usb_gadget() {
  msg "Enabling the USB gadget driver (dwc2)"
  local boot="/boot"
  [[ -d /boot/firmware ]] && boot="/boot/firmware"

  append_once "dtoverlay=dwc2" "$boot/config.txt"
  append_once "dwc2" "/etc/modules"

  # cmdline.txt must stay a single line; append the module loader if missing.
  if ! grep -q "modules-load=dwc2" "$boot/cmdline.txt"; then
    sed -i '$ s/$/ modules-load=dwc2/' "$boot/cmdline.txt"
    echo "    patched $boot/cmdline.txt"
  fi
}

create_usb_image() {
  if [[ -f "$USB_IMAGE" ]]; then
    msg "USB image $USB_IMAGE already exists — leaving it as-is"
    return
  fi
  msg "Creating ${USB_SIZE_GB}GB sparse USB image at $USB_IMAGE and formatting FAT32"
  truncate -s "${USB_SIZE_GB}G" "$USB_IMAGE"   # sparse: instant, grows on use
  mkfs.vfat -F 32 -I "$USB_IMAGE"
}

mount_usb_image() {
  msg "Mounting $USB_IMAGE at $MOUNT_DIR"
  mkdir -p "$MOUNT_DIR"
  chmod 777 "$MOUNT_DIR"
  # nofail = don't block boot if this mount fails; passno 0 = skip fsck.
  append_once "$USB_IMAGE $MOUNT_DIR vfat loop,nofail,users,umask=000,noatime 0 0" /etc/fstab
  mountpoint -q "$MOUNT_DIR" || mount "$MOUNT_DIR"
}

# Disable WiFi power-save so the Pi stays reliably reachable. The Broadcom chip
# on a Pi Zero 2 W can drop into a power-save state from which it doesn't fully
# recover, manifesting as "Pi disappears from the network after reboot".
disable_wifi_powersave() {
  msg "Disabling WiFi power-save (one-shot systemd unit)"
  local unit="/etc/systemd/system/wifi-powersave-off.service"
  cat > "$unit" <<'EOF'
[Unit]
Description=Disable WiFi power-save on wlan0
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/sbin/iw dev wlan0 set power_save off
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable wifi-powersave-off.service
  # Try it now; ignore failure (e.g. wlan0 not up yet).
  /sbin/iw dev wlan0 set power_save off 2>/dev/null || true
}

configure_samba() {
  msg "Configuring the Samba [usb] share"
  if ! grep -q '^\[usb\]' /etc/samba/smb.conf; then
    cat >> /etc/samba/smb.conf <<EOF

[usb]
   browseable = yes
   path = $MOUNT_DIR
   guest ok = yes
   read only = no
   create mask = 777
   directory mask = 777
EOF
    echo "    added [usb] share"
  fi
  systemctl restart smbd
}

install_bun_and_build() {
  msg "Installing Bun and building the ankermanager binary"
  if [[ ! -x "$BUN_INSTALL_DIR/bin/bun" ]]; then
    BUN_INSTALL="$BUN_INSTALL_DIR" bash -c 'curl -fsSL https://bun.sh/install | bash'
  else
    echo "    bun already installed at $BUN_INSTALL_DIR/bin/bun"
  fi
  "$BUN_INSTALL_DIR/bin/bun" build "$SCRIPT_DIR/ankermanager.ts" --compile --outfile "$APP_BIN"
  chmod +x "$APP_BIN"
  echo "    built $APP_BIN"
}

write_env_file() {
  msg "Setting the web UI login"
  local user pass
  read -rp "    Web username [anker]: " user
  user="${user:-anker}"
  read -rsp "    Web password: " pass; echo
  if [[ -z "$pass" ]]; then
    warn "Empty password — the web UI will have NO authentication."
  fi

  cat > "$ENV_FILE" <<EOF
FM_ROOT=$MOUNT_DIR
FM_PORT=$WEB_PORT
FM_DRIVER=$DRIVER
FM_USB_IMAGE=$USB_IMAGE
FM_USER=$user
FM_PASS=$pass
EOF
  chmod 600 "$ENV_FILE"
  echo "    wrote $ENV_FILE (permissions 600)"
}

remove_old_watchdog() {
  # Earlier versions of this project shipped a Python watchdog service; the new
  # app replaces it. Remove it if present so the two don't fight over the gadget.
  if systemctl list-unit-files | grep -q '^usbshare.service'; then
    msg "Removing the old Python usbshare.service"
    systemctl disable --now usbshare.service || true
    rm -f /etc/systemd/system/usbshare.service /usr/local/share/usbshare.py
  fi
}

install_service() {
  msg "Installing and starting ankermanager.service"
  cp "$SCRIPT_DIR/ankermanager.service" "$SERVICE"
  systemctl daemon-reload
  systemctl enable ankermanager.service
  systemctl restart ankermanager.service
}

# ----- Main ----------------------------------------------------------------
require_root
echo "AnkerMake WiFi File Manager installer"
echo "  USB image : $USB_IMAGE (${USB_SIZE_GB}GB sparse, FAT32)"
echo "  Mount     : $MOUNT_DIR"
echo "  Gadget    : $DRIVER"
echo "  Web port  : $WEB_PORT"

install_packages
enable_usb_gadget
disable_wifi_powersave
create_usb_image
mount_usb_image
configure_samba
install_bun_and_build
write_env_file
remove_old_watchdog
install_service

HOSTNAME_LOCAL="$(hostname).local"
msg "Done!"
echo "    Open the web UI at:  http://$HOSTNAME_LOCAL/   (or http://<pi-ip>/)"
echo "    Connect the Pi's micro-USB DATA port to the printer's USB-C port."
echo
echo "    !! IMPORTANT — before rebooting: open a SECOND ssh session to this Pi"
echo "       NOW. If WiFi doesn't come back after the reboot, that session will"
echo "       still let you in (or at least let you confirm the issue isn't your"
echo "       client). Then come back here and press Enter."
read -rp "Press Enter when ready to reboot (or Ctrl-C to skip reboot): " _
reboot
