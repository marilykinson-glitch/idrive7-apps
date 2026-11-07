'use strict';
/**
 * status.js - what the helper (vietmap-cluster) reports, read from /run/vietmap-cluster/status.json,
 * and the lines and the note the screen shows for it. No kit: the preview and the tests use it too.
 */
const fs = require('fs');

const STATUS = '/run/vietmap-cluster/status.json';
const STALE_MS = 15000;               // the helper writes every 2 s

function readStatus(file) {
    try {
        const s = JSON.parse(fs.readFileSync(file || STATUS, 'utf8'));
        return Date.now() - Date.parse(s.at) < STALE_MS ? s : Object.assign(s, { stale: true });
    } catch (e) { return null; }
}

/** What the screen says: the helper, the copy, the cluster map; the note under it. */
function report(s, want) {
    const lines = [];
    if (!s) {
        return { lines: [{ text: 'Helper not running', kind: 'warn' }],
            note: 'Install or update vietmap-cluster in the mgu Store', noteKind: 'warn' };
    }
    if (s.stale) lines.push({ text: 'Helper not answering', kind: 'warn' });
    else lines.push({ text: 'Helper running · ' + s.tool, kind: 'dim' });
    if (!s.waze || !s.waze.installed) lines.push({ text: 'Waze on cluster is not installed', kind: 'warn' });
    else if (s.waze.state) lines.push({ text: 'Cluster map: ' + s.waze.state + (s.waze.reason ? ' · ' + s.waze.reason : ''), kind: s.waze.state === 'error' ? 'warn' : 'dim' });
    if (s.on && s.grabber) {
        lines.push(s.grabber.running ? { text: 'Copying the centre screen', kind: 'go' }
            : { text: 'Screen copy stopped', kind: 'warn' });
    }
    let note = null, noteKind = 'dim';
    const pending = s.on !== want.on || (want.on && s.view !== want.view) || (want.on && !s.applied && !s.error);
    if (s.error) { note = s.error; noteKind = 'warn'; }
    else if (pending) note = 'Switching · a few seconds';
    else if (s.on) { note = 'The cluster shows the centre screen · HUD: Waze on cluster\'s Show on'; noteKind = 'go'; }
    else note = 'Off · Waze on cluster shows the phone\'s own cluster map';
    return { lines, note, noteKind, pending };
}

module.exports = { readStatus, report, STATUS, STALE_MS };
