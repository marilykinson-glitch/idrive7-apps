# car-probe: looks, for 15 s, at the SOME/IP messages passing the head unit's network interfaces, for
# those of navigation.ADAS (service 0xb51d): the map's speed limit on its way to the car. A raw socket
# that only receives; nothing is sent. Python 2 or 3.
from __future__ import print_function
import socket, struct, sys, time, binascii

WANT = 0xb51d
SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 15.0

def someip(payload):
    """The SOME/IP messages in a UDP payload: (service, method, type, body)."""
    out, o = [], 0
    while o + 16 <= len(payload):
        svc, meth, length = struct.unpack('!HHI', payload[o:o + 8])
        if length < 8 or o + 8 + length > len(payload) or payload[o + 12:o + 13] != b'\x01':
            break
        out.append((svc, meth, struct.unpack('!B', payload[o + 14:o + 15])[0], payload[o + 16:o + 8 + length]))
        o += 8 + length
    return out

def udp_of(frame):
    """The UDP payload of an Ethernet frame (IPv4 or IPv6, VLAN tag or not), or None."""
    o = 12
    et = struct.unpack('!H', frame[o:o + 2])[0]
    while et in (0x8100, 0x88a8) and o + 6 <= len(frame):
        o += 4
        et = struct.unpack('!H', frame[o:o + 2])[0]
    o += 2
    if et == 0x0800 and len(frame) >= o + 20:
        ihl = (struct.unpack('!B', frame[o:o + 1])[0] & 15) * 4
        if struct.unpack('!B', frame[o + 9:o + 10])[0] != 17:
            return None
        o += ihl
    elif et == 0x86dd and len(frame) >= o + 40:
        if struct.unpack('!B', frame[o + 6:o + 7])[0] != 17:
            return None
        o += 40
    else:
        return None
    return frame[o + 8:] if len(frame) >= o + 8 else None

def main():
    try:
        s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.ntohs(3))
    except Exception as e:
        print('no raw socket: %s' % e)
        return
    s.settimeout(1.0)
    frames = udp = 0
    seen, shown, ifs = {}, 0, {}
    end = time.time() + SECONDS
    while time.time() < end:
        try:
            frame, addr = s.recvfrom(65535)
        except socket.timeout:
            continue
        except Exception as e:
            print('receive: %s' % e)
            break
        frames += 1
        ifs[addr[0]] = ifs.get(addr[0], 0) + 1
        p = udp_of(frame)
        if p is None:
            continue
        udp += 1
        for svc, meth, typ, body in someip(p):
            k = '%04x:%04x' % (svc, meth)
            seen[k] = seen.get(k, 0) + 1
            if svc == WANT and shown < 20:
                shown += 1
                print('0xb51d method %d type 0x%02x on %s, %d bytes: %s' % (meth, typ, addr[0], len(body), binascii.hexlify(body[:96]).decode()))
    print('%d frames, %d UDP, on %s' % (frames, udp, ', '.join('%s %d' % kv for kv in sorted(ifs.items())) or 'no interface'))
    top = sorted(seen.items(), key=lambda kv: -kv[1])[:25]
    print('SOME/IP service:method seen: ' + (', '.join('%s x%d' % kv for kv in top) or 'none'))
    print('service 0xb51d: %d message(s)' % sum(v for k, v in seen.items() if k.startswith('b51d')))

main()
