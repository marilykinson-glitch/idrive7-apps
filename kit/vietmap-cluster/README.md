# vietmap-cluster

The root helper of [VietMap on cluster](../../apps/vietmap_cluster): it copies the centre screen to
the cluster's map area through Waze on cluster while the app says so. A tool in this repository's
`mgu-repo.json`, installed by the mgu Store with the app.

| File | |
|---|---|
| `vietmap-cluster.js` | the service (`run`), the Store's removal hook (`deactivate`), `status` |
| `vietmap-cluster.service` | runs it as root after the compositor, restarted on exit |
| `woc-dropin.conf` | a drop-in for `waze-on-cluster.service`: `EnvironmentFile=-/run/vietmap-cluster/woc.env` |
| `component.json` | the tool for the deploy tool |

Every 2 s it reads the app's settings (`data/settings.json` of the installed `vietmap_cluster`, its
defaults from the app's `app-spec.json`). On:

1. `/run/vietmap-cluster/woc.env` holds `WOC_SRC_CROP=-s avb_stream= -s src_crop=<view>`; the
   drop-in reads it after Waze on cluster's own `aa-crop.env`, so Waze on cluster runs without the
   phone's cluster stream and crops the copied screen. `waze-on-cluster.service` is restarted when
   the file changes.
2. `winston-grabber --screen=center --geometry=<view> --fps=15 --num-frames=0
   --pipeline="h264_msdk(gop=15,gop_ref_dist=1,cbr=<rate>), rtp, udp" udp://127.0.0.1:<udp_port>`
   (Waze on cluster's `udp_port`, 20557 by default), started again after 3 s, doubling to 60 s while
   it keeps ending.

| View | Captured | Crop (Waze on cluster's 1088x480 map area, 1:1) |
|---|---|---|
| fit | 1280x480 | 136,0 |
| zoom1 | 1600x600 | 308,60 |
| zoom2 | 1920x720 | 480,120 |

Off, at a stop of the service and at the Store's removal: the grabber stops, the env file goes and
Waze on cluster restarts as installed. `/run` is in memory, so a boot always starts without it.
Nothing of Waze on cluster, CarPlay or Android Auto is patched or edited.

The state is in `/run/vietmap-cluster/status.json` (0644): the app, on, view, whether Waze on cluster
is installed and its map state, the grabber (running, restarts, its last lines and exit) and an error.

Tests: `node kit/tools/test_vietmap_cluster.js`.
