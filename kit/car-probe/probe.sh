#!/bin/sh
# car-probe: a read-only survey of the head unit for the VietMap signs app: where BMW's own speed-limit
# sign can be read (the SOME/IP catalog's interfaces, their instances and types) and what the app got.
# It runs once at each install (component.json postInstall) and prints into the mgu Store's log, which
# the Store's phone page shows (Logs: updater). It changes nothing.
D=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node || echo /usr/bin/node)
sec() { echo "== $*"; }
echo "car-probe 0.2.2 begin $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"

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

sec "someip native module"
for p in /usr/lib /opt /var/opt/public/oap; do
    find "$p" -maxdepth 7 -type d -name someip -path '*node_modules*' 2>/dev/null | head -n 3
done

echo "car-probe end"
