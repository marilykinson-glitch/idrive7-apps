#!/bin/sh
# car-probe: a read-only survey of the head unit for the VietMap signs app: where BMW's own speed-limit
# sign can be read (the SOME/IP catalog's interfaces, their instances and types) and what the app got.
# It runs once at each install (component.json postInstall) and prints into the mgu Store's log, which
# the Store's phone page shows (Logs: updater). It changes nothing.
D=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node || echo /usr/bin/node)
sec() { echo "== $*"; }
echo "car-probe 0.5.0 begin $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"

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
if command -v tcpdump >/dev/null 2>&1; then
    CAP=/tmp/car-probe-cap.$$
    tcpdump -i any -n -c 12 -x -s 200 'udp and udp[8:2]=0xb51d' > "$CAP" 2>&1 &
    CPID=$!
    n=0
    while kill -0 "$CPID" 2>/dev/null && [ "$n" -lt 12 ]; do sleep 1; n=$((n + 1)); done
    kill "$CPID" 2>/dev/null
    sleep 1
    head -n 90 "$CAP" | cut -c 1-160
    rm -f "$CAP"
else
    echo "no tcpdump on this unit"
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
