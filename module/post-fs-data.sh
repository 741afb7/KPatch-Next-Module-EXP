#!/system/bin/sh

MODDIR=${0%/*}
KPNDIR="/data/adb/kp-next"
SERVICE_D="/data/adb/service.d"
STATUS_SH="$SERVICE_D/kp-next.sh"
PATH="$MODDIR/bin:$PATH"

mkdir -p "$KPNDIR"
if ! kpatch event post-fs-data before; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') failed to report post-fs-data event" >> "$KPNDIR/post-fs-data.log"
fi

mkdir -p "$SERVICE_D"
cp "$MODDIR/status.sh" "$STATUS_SH"
chmod 755 "$STATUS_SH"
