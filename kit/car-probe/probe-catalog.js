'use strict';
// car-probe: names in the unit's SOME/IP catalog matching a pattern (interface, field, its getter and
// notifier, and its type's member names one level down). Read only. Node 8.
//   node probe-catalog.js <regex> <max lines> [catalog]
const fs = require('fs');
const re = new RegExp(process.argv[2] || '.', 'i');
const max = Number(process.argv[3]) || 60;
const file = process.argv[4] || '/etc/oap/someip/someip-interfaces.json';
let db;
try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log('no catalog: ' + file + ' (' + e.message + ')'); process.exit(0); }
const types = db.datatypes || {};
function members(ref, depth) {
    const d = types[ref];
    if (!d) return ref;
    if (d.type === 'struct') {
        let mem = [], dd = d;
        for (let n = 0; dd && n < 8; n++) { mem = (dd.members || []).concat(mem); dd = dd.extends ? types[dd.extends] : null; }
        return depth > 0 ? 'struct' : '{' + mem.map((m) => m.name + (types[m.dataRef] && types[m.dataRef].type === 'enum' ? ':enum' : '')).join(',') + '}';
    }
    if (d.type === 'enum') return 'enum(' + Object.keys(d.items || {}).slice(0, 10).join(',') + ')';
    if (d.type === 'typedef') return members(d.dataRef || d.baseType, depth);
    if (d.type === 'array') return '[' + members(d.elementDataRef, depth + 1) + ']';
    return d.type;
}
const out = [];
Object.keys(db.interfaces || {}).forEach((name) => {
    const i = db.interfaces[name], hit = re.test(name);
    Object.keys(i.fields || {}).forEach((f) => {
        const fd = i.fields[f];
        if (hit || re.test(f)) out.push(name + ' . ' + f + (fd.getter ? ' get' : '') + (fd.notifier ? ' evt' : '') + ' ' + String(members(fd.dataRef, 0)).slice(0, 220));
    });
    ['methods', 'broadcasts', 'events'].forEach((k) => Object.keys(i[k] || {}).forEach((m) => { if (re.test(m)) out.push(name + ' ' + k + ' ' + m); }));
});
console.log(out.length + ' matches' + (out.length > max ? ', first ' + max : ''));
out.slice(0, max).forEach((l) => console.log(l));
