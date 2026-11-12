# VietMap signs

The speed-limit sign on the instrument cluster's map and on the HUD, while Google Maps (or Waze)
navigates on Android Auto and Waze on cluster shows its map there: the one BMW's own front camera
recognises first, else VietMap Live's.

```
 phone                                   car
 VietMap Live's speed bubble             vietmap-signs (root helper, kit/vietmap-signs)
   └ VietMap signs phone app  ──UDP 8471──>  └ an overlay image on cluster-render's map and hud
     (android/vmsign, reads the number)         targets, over Waze on cluster's map
```

- **BMW's front camera** (first; Settings: "BMW camera's sign first"): the helper, as root, listens to
  the camera's recognised signs (SOME/IP SignRecognitionFrontCamera; apps are not given it, and BMW's map
  limit, TrafficSignDisplayControl and CCP, never reached an app or root on a G30). Of the speed limits in
  one event, none under a plate for another vehicle or a condition (truck, trailer, rain, a time ...); of
  the rest the one most carry, the higher on a tie. Held until another sign, an end sign, or 3 km driven.
- **The centre screen** (CarPlay, off by default: it can misread): VietMap Live's CarPlay widget shows the sign beside Google Maps; the
  helper photographs the centre screen once a second with BMW's own grabber and reads the sign in it, on
  the car. No phone app then: the iPhone can stay locked in a pocket. Settings: "Read the sign on the
  centre screen (CarPlay)".
- **The phone app** ([android/vmsign](../../android/vmsign)) reads the number in VietMap Live's speed
  bubble with an accessibility service and sends it over the car's Wi-Fi (the car's own, which wireless
  Android Auto uses, or a phone hotspot the car is on) at each change and once a second.
- **The helper** ([kit/vietmap-signs](../../kit/vietmap-signs)), installed with this app, draws the sign
  (red ring, black number) through cluster-render, the renderer Waze on cluster draws with, only while
  Waze on cluster shows its map on the cluster or the HUD. 5 s after the phone's last word it goes.
- **This app**: On / Off, Show on (cluster and HUD, cluster only, HUD only), and in Settings the sign's
  position and size, the camera first or not, and the warning. The screen says where the sign comes
  from and what the camera saw.
- **Faster than the sign**: with the car's speed (Vehicle2) above the sign by the chosen margin (Settings:
  above it, 5 km/h above, the default, or 10; or off) the sign on the cluster and the HUD flashes
  as BMW's own does (on 0.6 s, off 0.4 s: the layers' opacity, from the helper's own timer). The speed is the helper's
  own (Vehicle2, as root), else the app's. The screen shows it.
- **Position** (the second tab): pictures of the cluster's map area and of the HUD (what it shows of its
  800x480 shaded, Waze on cluster's HUD map outlined) with the sign on each. A tap on a picture puts the
  sign's middle there; Up, Down, Left, Right move the one being edited 10 px; Default place puts it back.
  While this page shows, the sign shows on the cluster and the HUD even without the phone (60), so it can
  be placed while parked (Waze on cluster has to show its map). Saved as `mapX`, `mapY`, `hudX`, `hudY`
  (the sign's top-left in the target's pixels) in the app's settings; the page writes `data/preview.json`
  every second while it shows.
- English or Tiếng Việt in Settings (built with `--language vi --language-setting`).

**Install.** From this repository in the mgu Store; the helper installs with it. Waze on cluster (from
robertnisipeanu/idrive-apps, with its cluster-render) must be installed. The helper opens UDP 8471 on
the car's Wi-Fi interfaces while it runs (one tagged firewall rule each, removed when it stops or is
removed) and patches nothing.

Tests: `node kit/tools/test_vietmap_signs.js` (the helper against a made-up head unit).
