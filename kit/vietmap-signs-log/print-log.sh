#!/bin/sh
# Prints the VietMap signs helper's probe log into the Store's log (see print-log.js).
D=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node || echo /usr/bin/node)
exec "$NODE" "$D/print-log.js"
