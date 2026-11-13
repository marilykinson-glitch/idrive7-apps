#!/bin/sh
# Run both observers during the same drive and send their output to the Store log.
D=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node || echo /usr/bin/node)
PYTHON=$(command -v python3 || true)
if [ -z "$PYTHON" ]; then
    for candidate in /var/opt/mgu-python/current/bin/python3 /var/opt/mgu-python/versions/*/bin/python3; do
        if [ -x "$candidate" ]; then PYTHON=$candidate; break; fi
    done
fi
if [ -z "$PYTHON" ]; then
    echo "BMW Navigation probe: install mgu-python in MGU Store first"
    exit 1
fi
CP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/car-probe-nav.XXXXXX") || exit 1
export CP_DIR
LISTENER=
cleanup() {
    if [ -n "$LISTENER" ]; then
        kill "$LISTENER" 2>/dev/null || true
        wait "$LISTENER" 2>/dev/null || true
    fi
    rm -rf "$CP_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

CP_RUN_MS=100000 CP_BEAT_MS=15000 "$NODE" "$D/probe-listen.js" &
LISTENER=$!
"$PYTHON" -u "$D/probe-sniff.py" 90 > "$CP_DIR/wire.log" 2>&1
RESULT=$?
kill "$LISTENER" 2>/dev/null || true
wait "$LISTENER" 2>/dev/null || true
LISTENER=
echo "== BMW Navigation probe: time-ordered UTC log =="
for file in "$CP_DIR/car-probe-listen.log" "$CP_DIR/wire.log"; do
    if [ -f "$file" ]; then cat "$file"; fi
done | LC_ALL=C sort
exit "$RESULT"
