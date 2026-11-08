# vietmap-signs

The root helper of [VietMap signs](../../apps/vietmap_signs): the speed-limit sign the phone app
([android/vmsign](../../android/vmsign)) reads in VietMap Live, drawn over Waze on cluster's map on the
cluster and the HUD. A tool in this repository's `mgu-repo.json`, installed by the mgu Store with the app.

| File | |
|---|---|
| `vietmap-signs.js` | the service (`run`), the Store's removal hook (`deactivate`), `status`, `sign <n> <size>` (an RGBA dump) |
| `vietmap-signs.service` | runs it as root, restarted on exit |
| `digits.json` | the sign's digits, Inter Bold baked by `kit/tools/bake_sign_digits.py` (OFL-Inter.txt) |
| `component.json` | the tool for the deploy tool |

**The phone.** UDP 8471, JSON: `{"t":"vms","v":1,"seq":12,"limit":60,"app":"vmsign 0.1.0"}` at each
change and once a second (`limit` 0: no sign). Each is answered to its sender with
`{"t":"vms-ack","v":1,"seq":12,"car":"0.1.0","shown":["map","hud"],"why":""}` (`why`: why nothing is
shown). Senders outside the subnets of `wlan_bridge` (the car's Wi-Fi) and `wlan0` (a hotspot the car
is on) are not listened to. While it runs, one rule per interface at the top of `ip filter input`
accepts the port, tagged `vietmap-signs`, checked every 30 s, removed at a stop and by `deactivate`.

**The sign.** An image layer of cluster-render (`/var/opt/cluster-render/current/cluster_render_client.js`,
socket `/dev/shm/cluster-render/render.sock`), class `overlay`, on target `map` (1088x480; 200 px in from
the side, 36 down, inside the map area's fade) and on `hud` (inside Waze on cluster's HUD box, and inside the 680x300 the HUD shows of its 800x480), each
visible only while `/run/waze-on-cluster/status.json` says Waze on cluster shows its map there, so the
sign never asks the cluster for a slot of its own. `guide_hold` follows Waze on cluster's "Hide BMW's
turn". Sizes 96/128/160 on the cluster, 64/80/100 on the HUD.

**BMW first.** The app writes BMW's displayed limit to its `data/bmw_sign.json` once a second while it
runs; while that is fresh and valid and the app's setting is "BMW's sign only", the sign is hidden.

**Settings** come from the app's `data/settings.json` (`mode`, `show`, `side`, `size`, `bmw`), its
defaults from its `app-spec.json`; without the app: on, both, right, medium, BMW first.

The state is in `/run/vietmap-signs/status.json` (0644): the phone (address, last datagram, counts), the
limit, where it shows and why not, BMW's sign, Waze on cluster's map, the renderer's layers and targets,
the firewall rules.

Tests: `node kit/tools/test_vietmap_signs.js`.
