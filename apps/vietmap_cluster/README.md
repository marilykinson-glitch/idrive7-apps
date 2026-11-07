# VietMap on cluster

The centre screen's map (VietMap Live on Android Auto, or any app shown there) on the instrument
cluster's map area and the HUD.

Google Maps and Waze draw a second map for the cluster themselves, which
[Waze on cluster](https://github.com/robertnisipeanu/idrive-apps) shows. VietMap Live draws none, so
this app copies the centre screen instead: its helper, the root tool `vietmap-cluster`
([kit/vietmap-cluster](../../kit/vietmap-cluster)), runs BMW's own screen grabber (`winston-grabber
--screen=center`) into Waze on cluster's local UDP port, and Waze on cluster draws it where it draws
the phone's cluster map. The HUD follows Waze on cluster's **Show on**.

- **On / Off.** On: Waze on cluster runs without the phone's cluster stream and shows the copied
  centre screen. Off: Waze on cluster as installed (the phone's cluster map again).
- **View.** Whole map (most of the map, scaled down), Zoom 1.25× and Zoom 1.5× (smaller parts
  around the map's centre, sharper). The picture on the left shows the part the cluster gets.
- **Status.** What the helper reports: whether it runs, Waze on cluster's map state, whether the copy
  runs, and why not.
- English or Tiếng Việt in Settings (built with `--language vi --language-setting`).

The cluster shows what the centre screen shows: VietMap's zoom, its cards, and, when the centre
screen shows music or a BMW menu, that. Zoom in VietMap itself for a closer map.

**Install.** From this repository in the mgu Store; the helper installs with it. Waze on cluster
(from robertnisipeanu/idrive-apps) must be installed. Nothing is patched: off, at a stop of the
helper, its removal and after every boot, Waze on cluster runs as installed.

**How the two talk.** The app saves its choices (`mode`, `view`) in its `data/settings.json`; the
helper reads them every 2 s and writes `/run/vietmap-cluster/status.json`, which the app shows.

Tests: `node kit/tools/test_vietmap_cluster.js` (the helper against a made-up head unit).
