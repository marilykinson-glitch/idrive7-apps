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

CATALOG = '/etc/oap/someip/someip-interfaces.json'
HOT = ('speed', 'limit', 'sign', 'adas', 'navgraph', 'horizon', 'ccp', 'fasus', 'sli')

def names():
    """{service id: (interface, {member id: 'kind member'})} from the unit's catalog."""
    import json
    out = {}
    try:
        db = json.load(open(CATALOG))
    except Exception as e:
        print('catalog: %s' % e)
        return out
    for name, i in (db.get('interfaces') or {}).items():
        sid = i.get('serviceId')
        if not isinstance(sid, int):
            continue
        mem = {}
        for f, d in (i.get('fields') or {}).items():
            for k in ('getter', 'setter', 'notifier'):
                v = d.get(k) if isinstance(d, dict) else None
                if isinstance(v, dict) and isinstance(v.get('id'), int) and v['id']:
                    mem[v['id']] = k[:3] + ' ' + f
        for kind in ('events', 'broadcasts', 'methods'):
            for m, d in (i.get(kind) or {}).items():
                if not isinstance(d, dict):
                    continue
                for k in ('eventId', 'id', 'methodId'):
                    if isinstance(d.get(k), int):
                        mem[d[k]] = kind[:3] + ' ' + m
        out[sid] = (name, mem)
    return out

def main():
    try:
        s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.ntohs(3))
    except Exception as e:
        print('no raw socket: %s' % e)
        return
    s.settimeout(1.0)
    frames = udp = 0
    seen, samples, ifs = {}, {}, {}
    end = time.time() + SECONDS
    while time.time() < end:
        try:
            frame, addr = s.recvfrom(65535)
        except socket.timeout:
            continue
        except Exception as e:
            print('receive: %s' % e)
            break
        if addr[0] != 'socnet0' and not addr[0].startswith('vlan'):
            continue                # the car's network only; a VLAN's frames come on its own interface too
        if addr[0] == 'socnet0' and frame[12:14] not in (b'\x81\x00', b'\x88\xa8'):
            pass
        frames += 1
        ifs[addr[0]] = ifs.get(addr[0], 0) + 1
        p = udp_of(frame)
        if p is None:
            continue
        udp += 1
        for svc, meth, typ, body in someip(p):
            k = (svc, meth)
            seen[k] = seen.get(k, 0) + 1
            sm = samples.setdefault(k, [])
            h = binascii.hexlify(body[:80]).decode()
            if len(sm) < 3 and h not in sm:
                sm.append(h)
    print('%d frames, %d UDP, on %s' % (frames, udp, ', '.join('%s %d' % kv for kv in sorted(ifs.items())) or 'no interface'))
    cat = names()
    rows = []
    for (svc, meth), n in seen.items():
        iface, mem = cat.get(svc, ('?', {}))
        rows.append((n, svc, meth, iface, mem.get(meth, '?')))
    rows.sort(key=lambda r: (r[3], r[2]))
    print('%d SOME/IP members seen (count service:method interface member):' % len(rows))
    for n, svc, meth, iface, member in rows[:140]:
        hot = any(w in (iface + ' ' + member).lower() for w in HOT) or svc in (WANT, 0xb51c)
        line = 'x%d %04x:%04x %s %s' % (n, svc, meth, iface.replace('de.bmw.', ''), member)
        if hot:
            line += ' | ' + ' / '.join(samples.get((svc, meth), []))
        print(line)
    print('service 0xb51d: %d message(s)' % sum(v for k, v in seen.items() if k[0] == WANT))

main()
