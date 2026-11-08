'use strict';
// car-probe: everything the unit's SOME/IP catalog says about a few interfaces: their own keys
// (instances, ids), and the full types of their fields, events and broadcasts whose names match.
// Read only. Node 8.
//   node probe-iface.js <interface regex> <member regex> [catalog]
const fs = require('fs');
const ire = new RegExp(process.argv[2] || '^$', 'i'), mre = new RegExp(process.argv[3] || '.', 'i');
const file = process.argv[4] || '/etc/oap/someip/someip-interfaces.json';
let db;
try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log('no catalog: ' + file + ' (' + e.message + ')'); process.exit(0); }
const types = db.datatypes || {};
const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
function type(ref, depth) {
    const d = types[ref];
    if (!d) return String(ref);
    if (depth > 3) return d.type || '?';
    if (d.type === 'struct') {
        let mem = [], dd = d;
        for (let n = 0; dd && n < 8; n++) { mem = (dd.members || []).concat(mem); dd = dd.extends ? types[dd.extends] : null; }
        return '{' + mem.map((m) => m.name + ':' + type(m.dataRef, depth + 1)).join(', ') + '}';
    }
    if (d.type === 'enum') {
        const it = d.items || {};
        return 'enum(' + Object.keys(it).slice(0, 24).map((k) => k + '=' + (typeof it[k] === 'object' ? JSON.stringify(it[k]) : it[k])).join(' ') + ')';
    }
    if (d.type === 'typedef') return type(d.dataRef || d.baseType, depth);
    if (d.type === 'array') return '[' + type(d.elementDataRef, depth + 1) + ']';
    return d.type || JSON.stringify(d).slice(0, 60);
}
const names = Object.keys(db.interfaces || {}).filter((n) => ire.test(n));
console.log(names.length + ' interfaces');
names.forEach((name) => {
    const i = db.interfaces[name];
    const own = {};
    Object.keys(i).forEach((k) => { if (['fields', 'methods', 'broadcasts', 'events'].indexOf(k) < 0) own[k] = i[k]; });
    console.log('# ' + name + ' ' + cut(JSON.stringify(own), 500));
    Object.keys(i.fields || {}).forEach((f) => {
        if (!mre.test(f)) return;
        const fd = i.fields[f];
        console.log('  field ' + f + (fd.getter ? ' get' : '') + (fd.notifier ? ' evt' : '') + ' ' + cut(type(fd.dataRef, 0), 900));
    });
    ['events', 'broadcasts'].forEach((k) => Object.keys(i[k] || {}).forEach((m) => {
        if (!mre.test(m)) return;
        const e = i[k][m];
        const args = (e.arguments || e.outArgs || e.parameters || []).map((a) => a.name + ':' + type(a.dataRef, 0));
        console.log('  ' + k.slice(0, -1) + ' ' + m + ' ' + cut(args.length ? args.join(', ') : type(e.dataRef, 0) + ' ' + JSON.stringify(Object.keys(e)), 900));
    }));
});
