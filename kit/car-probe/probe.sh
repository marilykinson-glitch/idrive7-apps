#!/bin/sh
# car-probe: a read-only survey of the head unit for the VietMap signs app; now: where the car says which
# turn signal is on (the catalog's names, and what they send for 45 s). Earlier probes' scripts stay here.
# It runs once at each install (component.json postInstall) and prints into the mgu Store's log, which
# the Store's phone page shows (Logs: updater). It changes nothing.
D=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node || echo /usr/bin/node)
sec() { echo "== $*"; }
echo "car-probe 0.6.0 begin $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"

sec "the turn signal (flick it left, right, hazard lights, while this runs)"
OUT=/tmp/car-probe-blink.$$
"$NODE" "$D/probe-blinker.js" > "$OUT" 2>&1 &
PID=$!
n=0
while kill -0 "$PID" 2>/dev/null && [ "$n" -lt 90 ]; do sleep 1; n=$((n + 1)); done
kill -0 "$PID" 2>/dev/null && { kill -9 "$PID" 2>/dev/null; echo "blinker probe: stopped after 90 s"; }
cut -c 1-600 "$OUT" | head -n 300
rm -f "$OUT"

sec "someip native module"
ls -l /usr/lib/someip.node 2>&1
for p in /usr/lib /opt /var/opt/public/oap; do
    find "$p" -maxdepth 7 -type d -name someip -path '*node_modules*' 2>/dev/null | head -n 3
done

echo "car-probe end"
