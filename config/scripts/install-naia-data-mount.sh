#!/usr/bin/env bash
set -euo pipefail

# install-naia-data-mount.sh — register the persistent-data mount unit during image build.
#
# At runtime, var-home-liveuser.mount auto-mounts a partition labeled "naia-data"
# directly at /var/home/liveuser (the live session user's home), BEFORE livesys
# creates the live user. livesys then sees a pre-existing home (useradd -M) and
# chowns + restorecons it, so the entire home — settings, conversations, memory,
# and ~/naia-adk — persists across reboots of the live USB.
#
# If no naia-data partition exists (e.g., installed system, or live boot without
# the persistent USB), the mount is a no-op (nofail + device Requires).
#
# Legacy var-naia.mount (+ ~/naia-adk symlink) is left in the image but NOT
# enabled — superseded by whole-home persistence.
#
# See issue #262.

echo "[naia] Setting up persistent liveuser-home mount..."

# Keep the legacy symlink helper executable (harmless no-op when /var/naia absent)
chmod 0755 /usr/libexec/naia-adk-link

# Enable the whole-home persistent mount so systemd attempts it on boot
# (ordered before livesys.service via the unit's Before=).
systemctl enable var-home-liveuser.mount

echo "[naia] Persistent home mount registered (var-home-liveuser.mount enabled)"
