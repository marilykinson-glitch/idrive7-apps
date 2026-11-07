# VietMap signs

VietMap Live's speed-limit sign on the instrument cluster's map and on the HUD, while Google Maps (or
Waze) navigates on Android Auto and Waze on cluster shows its map there.

```
 phone                                   car
 VietMap Live's speed bubble             vietmap-signs (root helper, kit/vietmap-signs)
   └ VietMap signs phone app  ──UDP 8471──>  └ an overlay image on cluster-render's map and hud
     (android/vmsign, reads the number)         targets, over Waze on cluster's map
```

- **The phone app** ([android/vmsign](../../android/vmsign)) reads the number in VietMap Live's speed
  bubble with an accessibility service and sends it over the car's Wi-Fi (the car's own, which wireless
  Android Auto uses, or a phone hotspot the car is on) at each change and once a second.
- **The helper** ([kit/vietmap-signs](../../kit/vietmap-signs)), installed with this app, draws the sign
  (red ring, black number) through cluster-render, the renderer Waze on cluster draws with, only while
  Waze on cluster shows its map on the cluster or the HUD. 5 s after the phone's last word it goes.
- **This app**: On / Off, Show on (cluster and HUD, cluster only, HUD only), and in Settings the sign's
  position, its size, and what happens while BMW shows its own sign: BMW's sign only (the default) or
  VietMap's too. For that it reads BMW's displayed speed limit (SOME/IP TrafficSignDisplayControl)
  while it runs and writes it to its `data/bmw_sign.json` once a second; the screen shows it.
- English or Tiếng Việt in Settings (built with `--language vi --language-setting`).

**Install.** From this repository in the mgu Store; the helper installs with it. Waze on cluster (from
robertnisipeanu/idrive-apps, with its cluster-render) must be installed. The helper opens UDP 8471 on
the car's Wi-Fi interfaces while it runs (one tagged firewall rule each, removed when it stops or is
removed) and patches nothing.

Tests: `node kit/tools/test_vietmap_signs.js` (the helper against a made-up head unit).
