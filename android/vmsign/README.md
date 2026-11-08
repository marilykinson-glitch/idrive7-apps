# VietMap Signs (phone app)

The phone half of [VietMap signs](../../apps/vietmap_signs): reads the speed-limit number in VietMap
Live's floating speed bubble on an Android phone and sends it over Wi-Fi to the car, whose helper
([kit/vietmap-signs](../../kit/vietmap-signs)) draws the sign over Waze on cluster's map on the cluster
and the HUD. Android (Java; ML Kit text recognition, bundled), minSdk 26.

**Get it.** GitHub Actions builds it at every change here (`.github/workflows/vmsign-apk.yml`) and
publishes a release: on the phone, open
`https://github.com/<owner>/idrive7-apps/releases/latest/download/VietMapSigns.apk`, open the download,
allow installing from the browser. A failed build's log is in the branch `ci-log`.

**Set it up** (the app's screen says what is missing):
1. Accessibility: Settings → Accessibility → Downloaded apps → VietMap Signs → on. Android 13 and later
   block that for an app from a browser at first ("restricted setting"): Settings → Apps → VietMap Signs
   → ⋮ → Allow restricted settings, then turn it on.
2. Battery: no restrictions (the app's button). On Xiaomi also Autostart.
3. Notification access: optional, for VietMap notifications that carry the sign.
4. Open VietMap Live so its speed bubble shows. The app reads the number in the bubble's red-ringed
   sign by itself; if it ever reads the wrong thing, tap the right line in list "5." to keep that one.

**What it reads.** Only windows and notifications of packages whose name has "vietmap" in it
(`vn.vietmap.live`); of other windows only the package name, shown on the screen. VietMap's bubble
draws its numbers itself (no text Android can hand over), so each VietMap window is also photographed
about once a second (Android 14+: that window alone, `takeScreenshotOfWindow`; Android 11-13: the
screen, cut to the window), the red rings in it found and the number inside each read with ML Kit's
bundled text recognition, on the phone; the pictures are not kept. The biggest red-ringed number is the
sign; the speed you drive is never in a red ring. The bubble is read
while the screen is on and unlocked: "keep the screen on" (the default) keeps it on while VietMap shows a
window, with a 1x1 accessibility overlay.

**What it sends.** UDP 8471, `{"t":"vms","v":1,"seq":12,"limit":60,"app":"vmsign 0.1.0"}` at each change
and once a second (`limit` 0: none). Until the car answers, to 172.16.222.97 (the BMW's own Wi-Fi), to the
IP typed in the app, and to the broadcast address of every network the phone is on, from the default
socket and one bound to each Wi-Fi network Android lets it use; then only to the car, the way it answered.
Test signs (50, 80, 120) from the screen show for 15 s.

**Signing.** The APK is signed with `vmsign.p12` kept here (password `vmsign-public`), so each build
installs over the last. It is a key for this side-loaded app only: anyone can sign with it, so install
VietMap Signs only from this repository's releases.

Build locally (Android SDK, Gradle 8.7+): `gradle -p android/vmsign assembleRelease`.
