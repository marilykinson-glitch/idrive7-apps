'use strict';
/**
 * status.js - what the helper (vietmap-signs) reports, read from /run/vietmap-signs/status.json, the
 * lines and the note the screen shows for it, and BMW's own sign from its SOME/IP field. No kit: the
 * preview and the tests use it too.
 */
const fs = require('fs');

const STATUS = '/run/vietmap-signs/status.json';
const STALE_MS = 15000;               // the helper writes every 2 s at least

function readStatus(file) {
    try {
        const s = JSON.parse(fs.readFileSync(file || STATUS, 'utf8'));
        return Date.now() - Date.parse(s.at) < STALE_MS ? s : Object.assign(s, { stale: true });
    } catch (e) { return null; }
}

const WHY = {
    'off in the app': 'Off',
    'no phone yet': 'Waiting for the phone app',
    'the phone stopped sending': 'The phone stopped sending',
    'no sign in VietMap': 'No sign in VietMap now',
    'BMW shows its own sign': 'BMW shows its own sign',
    'cluster-render is not installed': 'Install Waze on cluster (with cluster-render) in the mgu Store',
    'Waze on cluster is not installed': 'Install Waze on cluster in the mgu Store',
    'Waze on cluster shows no map there': 'Shown when Waze on cluster shows the map',
};

function ago(ms) {
    if (ms === null || ms === undefined) return '';
    return ms < 2000 ? 'just now' : Math.round(ms / 1000) + ' s ago';
}

/**
 * BMW's displayed speed limit from TrafficSignDisplayControl.displaySpeedLimitAndNoPassingRestriction:
 * { limit (km/h, or null), valid, raw } - valid only for a plain number the cluster shows.
 */
function bmwFrom(v) {
    if (!v || typeof v !== 'object') return { limit: null, valid: false, raw: null };
    const limit = Number(v.displaySpeedLimit);
    const style = v.displaySymbolStyle;
    const invalid = v.invalidFlag === true || Number(v.invalidFlag) === 1;
    const hidden = (typeof style === 'string' && /NO_?DISPLAY|NONE|^OFF|INVALID|NOT_|INACTIVE|UNKNOWN|NO_SIGN/i.test(style)) || style === 0;
    const valid = !invalid && !hidden && limit >= 5 && limit <= 150;
    return {
        limit: valid ? limit : null, valid,
        raw: { style: style === undefined ? null : style, limit: v.displaySpeedLimit === undefined ? null : v.displaySpeedLimit,
            invalid: v.invalidFlag === undefined ? null : v.invalidFlag, unit: v.displaySpeedLimitUnit === undefined ? null : v.displaySpeedLimitUnit },
    };
}

/** What the screen says: the phone, BMW's sign, the cluster and the HUD; the note under it. */
function report(s, want, bmw) {
    const lines = [];
    if (!s) {
        return { limit: null, lines: [{ text: 'Helper not running', kind: 'warn' }],
            note: 'Install or update vietmap-signs in the mgu Store', noteKind: 'warn' };
    }
    if (s.stale) lines.push({ text: 'Helper not answering', kind: 'warn' });
    const p = s.phone || {};
    if (!p.at) lines.push({ text: 'Phone: not connected yet', kind: 'warn' });
    else lines.push({ text: 'Phone: ' + p.from + ' · ' + ago(p.ago_ms), kind: p.ago_ms < 5000 ? 'go' : 'warn' });
    if (bmw && bmw.available === false) lines.push({ text: 'BMW sign: no signal', kind: 'dim' });
    else if (bmw && bmw.valid) lines.push({ text: 'BMW sign: ' + bmw.limit + ' km/h', kind: 'dim' });
    else if (bmw) lines.push({ text: 'BMW sign: none', kind: 'dim' });
    const shown = s.shown || [];
    // the renderer's word on a layer that should show but does not (yet)
    const layer = (t) => {
        const l = s.renderer && s.renderer.layers && s.renderer.layers[t];
        return l && l.state && l.state !== 'shown' ? ' · ' + l.state + (l.reason ? ' (' + l.reason + ')' : '') : '';
    };
    lines.push({ text: 'Cluster: ' + (shown.indexOf('map') >= 0 ? 'shown' + layer('map') : s.waze && s.waze.map ? 'map shown, no sign' : 'no map'), kind: shown.indexOf('map') >= 0 ? 'go' : 'dim' });
    lines.push({ text: 'HUD: ' + (shown.indexOf('hud') >= 0 ? 'shown' + layer('hud') : s.waze && s.waze.hud ? 'map shown, no sign' : 'no map'), kind: shown.indexOf('hud') >= 0 ? 'go' : 'dim' });
    let note, noteKind = 'dim';
    const pending = s.settings && want && (s.settings.on !== want.on || s.settings.show !== want.show);
    if (pending) note = 'Switching · a second';
    else if (s.renderer && s.renderer.error && !(s.renderer.installed === false)) { note = s.renderer.error; noteKind = 'warn'; }
    else if (s.firewall && s.firewall.error) { note = 'Firewall: ' + s.firewall.error; noteKind = 'warn'; }
    else if (shown.length) { note = shown.length > 1 ? 'Shown on the cluster and the HUD' : shown[0] === 'map' ? 'Shown on the cluster' : 'Shown on the HUD'; noteKind = 'go'; }
    else note = WHY[s.why] || s.why || '';
    if (/install/i.test(note || '')) noteKind = 'warn';
    return { limit: s.limit || null, phoneLimit: p.limit || null, lines, note, noteKind, pending: !!pending };
}

module.exports = { readStatus, report, bmwFrom, STATUS, STALE_MS, WHY };
