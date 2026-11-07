#!/bin/sh
# car-probe: a read-only survey of the head unit for the VietMap speed-sign and VietMap on cluster apps.
# It runs once at each install (component.json postInstall) and prints into the mgu Store's log, which
# the Store's phone page shows (Logs: updater). It changes nothing.
D=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node || echo /usr/bin/node)
sec() { echo "== $*"; }
echo "car-probe 0.1.0 begin $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"

sec "unit"
uname -r
grep -m1 -i -E 'pretty_name|version' /etc/os-release 2>/dev/null
for f in /etc/version /etc/sw_version; do [ -f "$f" ] && head -n 1 "$f"; done

sec "network: addresses"
(ip -4 addr 2>/dev/null || ifconfig 2>/dev/null) | grep -E '^[0-9]+:|^[a-z]|inet ' | sed 's/^ *//' | head -n 30
sec "network: neighbours (a phone on the car's Wi-Fi shows here)"
(ip -4 neigh 2>/dev/null || cat /proc/net/arp) | head -n 15
sec "firewall: input chain, first rules"
nft list chain ip filter input 2>/dev/null | head -n 20

sec "cluster drawing"
for t in cluster-render waze-on-cluster vietmap-cluster idrive7-renderd; do
    v=$(grep -o -m1 '"version" *: *"[^"]*"' /var/opt/$t/current/component.json 2>/dev/null)
    echo "$t: ${v:-not installed} $(systemctl is-active $t.service 2>/dev/null)"
done
ls /run/cluster-render 2>/dev/null | head -n 10
head -c 600 /run/waze-on-cluster/status.json 2>/dev/null; echo

sec "speed limit / traffic sign names in the SOME/IP catalog"
"$NODE" "$D/probe-catalog.js" 'speed.?limit|traffic.?sign|verkehrs|vzerk|\bvze|\bsli\b|kafas|geschwind|maxspeed|legal.?speed|sign.?recog|speedinfo' 70
sec "Android Auto / projection names in the SOME/IP catalog"
"$NODE" "$D/probe-catalog.js" 'android.?auto|projection|aapd|smartphone|carplay|videofocus|mirror|hmi.?context|activeapp|foreground' 40
sec "aapd: focus lines this boot"
journalctl -u aapd -b --no-pager 2>/dev/null | grep -i -E 'focus|projection|videofocus|native|projected' | tail -n 15

echo "car-probe end"
