#!/bin/sh
# Naia launcher — select the GTK backend per session.
#
# Why: forcing GDK_BACKEND=x11 makes the main Tauri window map at 1x1 (invisible)
# on KDE Wayland (KWin XWayland). Native Wayland renders the window correctly.
# But X11 sessions still need x11 so the browser panel's Chrome embedding
# (XReparentWindow / find_tauri_xid via X11 atoms) can locate the window.
#
# So: Wayland session -> GDK_BACKEND=wayland (main window works).
#     X11 session     -> GDK_BACKEND=x11 (browser-panel embedding works).
if [ "${XDG_SESSION_TYPE}" = "wayland" ] || { [ -z "${XDG_SESSION_TYPE}" ] && [ -n "${WAYLAND_DISPLAY}" ]; }; then
	export GDK_BACKEND=wayland
else
	export GDK_BACKEND=x11
fi
exec /app/bin/naia-os "$@"
