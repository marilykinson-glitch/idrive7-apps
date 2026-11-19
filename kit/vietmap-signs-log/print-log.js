'use strict';
/**
 * print-log.js - prints the probe's log (kit/vietmap-signs/probe.js: what the unit's interfaces say of
 * speed limits and signs) for the MGU Store's log; the Store runs this once when the tool is installed,
 * its phone page shows it under Logs: updater. Read only. Lines are cut into pieces of 700 characters.
 * What the unit has (found, proxy, names) comes whole; of the values, per member the first 6 different
 * ones and the newest 60, so a chatty member cannot crowd the others out. Node 8.
 */
const fs = require('fs');
const RUN = process.env.VMS_RUN || '/run/vietmap-signs';
const PIECE = 700, MAX_PIECES = 1500;
let n = 0;
const out = (tag, text) => {
    text = String(text);
    for (let i = 0; i < text.length || i === 0; i += PIECE) {
        if (n >= MAX_PIECES) return;
        console.log('VMS ' + tag + (text.length > PIECE ? ' [' + (Math.floor(i / PIECE) + 1) + '/' + Math.ceil(text.length / PIECE) + '] ' : ' ') + text.slice(i, i + PIECE));
        n++;
    }
};
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } };

out('==', 'Bien bao VietMap: nhat ky do bien ban do BMW, ' + new Date().toISOString());
try {
    const st = JSON.parse(fs.readFileSync(RUN + '/status.json', 'utf8'));
    out('status', JSON.stringify({ tool: st.tool, probe: st.probe, camera: st.camera, speed: st.speed, limit: st.limit, source: st.source }));
} catch (e) { out('status', 'khong doc duoc status.json: ' + e.message); }
const all = lines(RUN + '/probe.log.1').concat(lines(RUN + '/probe.log'));
if (!all.length) out('probe', 'chua co probe.log: bat "Do bien toc do cua ban do BMW" trong Cai dat cua app, chay xe vai phut roi cai lai cong cu nay');
const head = [], values = {}, order = [];
all.forEach((l) => {
    let j = null;
    try { j = JSON.parse(l.replace(/^\S+ /, '')); } catch (e) { /* a plain line */ }
    if (!j || j.ev !== 'value') { head.push(l); return; }
    const k = j.iface + '|' + j.name + ' @ instance ' + (j.inst === undefined ? '?' : j.inst);
    if (!values[k]) { values[k] = []; order.push(k); }
    values[k].push(l);
});
// the unit's lists once (the newest start), then the values
const starts = head.map((l, i) => (/"ev":"start"/.test(l) ? i : -1)).filter((i) => i >= 0);
head.slice(starts.length ? starts[starts.length - 1] : 0).forEach((l) => out('probe', l));
order.forEach((k) => {
    const v = values[k], show = v.length <= 70 ? v : v.slice(0, 10).concat(v.slice(-60));
    out('member', k + ' (' + v.length + ' gia tri khac nhau)');
    show.forEach((l) => out('value', l.replace(/"iface":"[^"]*",("inst":"[^"]*",)?"name":"[^"]*",/, '')));
});
out('==', 'het (' + n + ' dong)');
