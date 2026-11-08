# car-probe

A read-only survey of the head unit for the VietMap apps, run from the mgu Store without a computer:
installing it runs `probe.sh` once (`postInstall`), which prints into the Store's log; the Store's
phone page shows it (Settings → Phone access → On, scan the QR code, Logs: updater). Remove it
afterwards. It changes nothing.

It prints the car's network addresses and neighbours (a phone on the car's Wi-Fi), the first rules of
the firewall's input chain, which cluster tools are installed, the speed-limit / traffic-sign and the
Android Auto / projection names in the SOME/IP catalog (`probe-catalog.js`, names and types only, no
values), and aapd's focus lines of this boot.

0.2.0: BMW's own speed-limit sign. `probe-iface.js` prints everything the SOME/IP catalog says about the
interfaces it may come from (TrafficSignDisplayControl, the navigation's adasng CCP and ADAS, FASuS,
SignRecognitionFrontCamera): their instances and ids, and the full types of their speed, sign and limit
fields and events; then what the VietMap signs app got (its generated interface configs, its log's BMW lines),
and where the someip native module is.
