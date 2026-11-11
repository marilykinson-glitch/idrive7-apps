#!/bin/sh
# car-probe: a read-only survey of the head unit for the VietMap signs app: where BMW's own speed-limit
# sign can be read (the SOME/IP catalog's interfaces, their instances and types) and what the app got.
# It runs once at each install (component.json postInstall) and prints into the mgu Store's log, which
# the Store's phone page shows (Logs: updater). It changes nothing.
D=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node || echo /usr/bin/node)
sec() { echo "== $*"; }
echo "car-probe 0.5.2 begin $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"

sec "BMW speed-limit interfaces"
"$NODE" "$D/probe-iface.js" 'TrafficSignDisplayControl|adasng\.CCP$|navigation\.ADAS$|fasus\.FASuS$|SignRecognitionFrontCamera$' \
    'speed|sign|limit'

sec "VietMap signs app"
for d in /var/opt/public/oap/oap_*; do
    for s in "$d/source/javascript/kit/app-spec.json" "$d/javascript/kit/app-spec.json"; do
        [ -f "$s" ] && grep -q '"id": *"vietmap_signs' "$s" && APP=$d
    done
done
if [ -n "$APP" ]; then
    echo "app: $APP"
    ls "$APP/someipInterfaces" 2>/dev/null | head -n 20
    for f in "$APP"/someipInterfaces/*TrafficSign*.json "$APP"/someipInterfaces/*adasng*.json; do
        [ -f "$f" ] && { echo "-- $(basename "$f")"; head -c 700 "$f"; echo; }
    done
    for f in "$APP"/data/*.log; do
        [ -f "$f" ] && grep -E 'BMW |signals |subscribe ' "$f" | grep -v USSO | tail -n 40
    done
else
    echo "app: not installed"
fi

sec "asked as root (read only)"
# at most 40 s: the binding is the unit's own, a call that never returns must not hold the install
OUT=/tmp/car-probe-read.$$
"$NODE" "$D/probe-read.js" > "$OUT" 2>&1 &
PID=$!
n=0
while kill -0 "$PID" 2>/dev/null && [ "$n" -lt 40 ]; do sleep 1; n=$((n + 1)); done
kill -0 "$PID" 2>/dev/null && { kill -9 "$PID" 2>/dev/null; echo "read probe: stopped after 40 s"; }
cut -c 1-1100 "$OUT"
rm -f "$OUT"

# The map's speed limit goes one way, from the head unit to the car (navigation.ADAS, service 46365 =
# 0xb51d, setters only, over UDP). Is there a tool here that can see those messages go out? 12 s, looking only.
sec "the map's limit on its way to the car (service 0xb51d)"
for t in tcpdump tshark dumpcap; do command -v "$t" >/dev/null 2>&1 && echo "has $t: $(command -v "$t")"; done
ip -o link 2>/dev/null | cut -d: -f2 | tr -d ' ' | tr '\n' ' '; echo
# no tcpdump here (seen on the car): Python with a raw socket, if the unit has one (mgu-python or its own)
PY=""
for c in python3 python /opt/mgu-python/bin/python3 /var/opt/mgu-python/bin/python3 /usr/local/bin/python3; do
    p=$(command -v "$c" 2>/dev/null) && [ -n "$p" ] && { PY=$p; break; }
done
[ -z "$PY" ] && PY=$(find /opt /var/opt /usr/local /usr/lib -maxdepth 5 -type f -name 'python3*' ! -name '*.so*' ! -name '*-config' 2>/dev/null | head -n 1)
if [ -n "$PY" ]; then
    echo "python: $PY"
    "$PY" "$D/probe-sniff.py" 30 2>&1 | cut -c 1-700 &
    SPID=$!
    n=0
    while kill -0 "$SPID" 2>/dev/null && [ "$n" -lt 45 ]; do sleep 1; n=$((n + 1)); done
    kill -9 "$SPID" 2>/dev/null
else
    echo "no python on this unit (the Store has one: mgu-python)"
fi

sec "heard while driving (the last listen)"
LDIR=/var/opt/public; [ -d "$LDIR" ] || LDIR=/tmp
if [ -f "$LDIR/car-probe-listen.log" ]; then tail -n 400 "$LDIR/car-probe-listen.log" | cut -c 1-900; else echo "no listen yet"; fi
# a new listen, 25 minutes, on its own (stopped when car-probe is removed)
"$NODE" "$D/probe-listen.js" stop
if command -v systemd-run >/dev/null 2>&1; then
    systemd-run --quiet --unit="car-probe-listen-$$" "$NODE" "$D/probe-listen.js" 2>&1 && echo "listening for 25 min (systemd)"
elif command -v setsid >/dev/null 2>&1; then
    setsid "$NODE" "$D/probe-listen.js" >/dev/null 2>&1 < /dev/null &
    echo "listening for 25 min (setsid)"
else
    nohup "$NODE" "$D/probe-listen.js" >/dev/null 2>&1 < /dev/null &
    echo "listening for 25 min (nohup)"
fi

sec "someip native module"
ls -l /usr/lib/someip.node 2>&1
for p in /usr/lib /opt /var/opt/public/oap; do
    find "$p" -maxdepth 7 -type d -name someip -path '*node_modules*' 2>/dev/null | head -n 3
done

echo "car-probe end"
