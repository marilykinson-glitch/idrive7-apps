# car-probe

A read-only survey of the head unit for the VietMap apps, run from the mgu Store without a computer:
installing it runs `probe.sh` once (`postInstall`), which prints into the Store's log; the Store's
phone page shows it (Settings → Phone access → On, scan the QR code, Logs: updater). Remove it
afterwards. It changes nothing.

It prints the car's network addresses and neighbours (a phone on the car's Wi-Fi), the first rules of
the firewall's input chain, which cluster tools are installed, the speed-limit / traffic-sign and the
Android Auto / projection names in the SOME/IP catalog (`probe-catalog.js`, names and types only, no
values), and aapd's focus lines of this boot.
