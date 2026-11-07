'use strict';
// BM3 CustomROM controls on the DME, from BM3 Live by ezl0l (idrive7-apps PR #29).

const fs = require('fs');
const path = require('path');

const DME = 0x12;
const MARKER_SIZE = 0xFF;
const MARKER = Buffer.from('BM3_R');

// Marker search, used only when the marker is not at config.bm3MarkerAddress (that address was
// validated on one G22; other DMEs and ROMs keep it elsewhere). Read-only: a temporary identifier
// is defined over each place (2C 02 F301) and read (22 F301), exactly as the normal check does.
// Places: the same distance below the end of every 1 MB of program flash as 0x807FFE50 sits below
// the end of 8 MB, then the last 4 KB of every 1 MB, in overlapping 255-byte reads.
const FLASH_BASE = 0x80000000;
const FLASH_MB = 16;
const MB = 0x100000;
const SAME_OFFSET = 0x1B0;
const TAIL = 0x1000;
const STEP = 0xF0;              // 15 bytes of overlap, so a marker across two reads is not missed
const SAVED_FILE = 'bm3_marker.json';

function hex32(n) { return (n >>> 0).toString(16).toUpperCase().padStart(8, '0'); }

function addressBytes(value) {
    if (typeof value !== 'string' || !/^[0-9A-Fa-f]{8}$/.test(value)) throw new Error('invalid 32-bit address');
    return Array.from(Buffer.from(value, 'hex'));
}

function positive(reply, sid, prefix) {
    if (!reply) { const e = new Error('DME did not answer'); e.noAnswer = true; throw e; }
    if (reply[0] === 0x7F) {
        const e = new Error('DME rejected ' + sid.toString(16).toUpperCase() + ': NRC ' + reply[2].toString(16).toUpperCase().padStart(2, '0'));
        e.nrc = reply[2];
        throw e;
    }
    const want = [sid + 0x40].concat(prefix || []);
    if (want.some((b, i) => reply[i] !== b)) throw new Error('unexpected DME response: ' + Buffer.from(reply).toString('hex').toUpperCase());
    return reply;
}

/** "BM3_R..." up to the first byte that is not printable (64 characters at most), or null. */
function markerText(data) {
    const i = data.indexOf(MARKER);
    if (i < 0) return null;
    let j = i;
    while (j < data.length && j - i < 64 && data[j] >= 0x20 && data[j] < 0x7F) j++;
    return data.slice(i, j).toString('latin1');
}

/** First bytes of a read, for the log: hex and printable text. */
function preview(data) {
    const head = Buffer.from(data).slice(0, 32);
    const text = Array.from(head).map((b) => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.')).join('');
    return head.toString('hex').toUpperCase() + ' |' + text + '|';
}

function romFromData(data, profiles) {
    if (data.indexOf(MARKER) < 0) throw new Error('BM3 CustomROM marker absent');
    const text = data.toString('latin1');
    const keys = Object.keys(profiles || {}).filter((key) => text.includes('#' + key));
    if (keys.length !== 1) throw new Error('BM3 ROM key not uniquely matched in marker (' + markerText(data) + ')');
    return keys[0];
}

function markerRom(reply, profiles) {
    positive(reply, 0x22, [0xF3, 0x01]);
    return romFromData(Buffer.from(reply.slice(3)), profiles);
}

/** The places the search reads, in order (config / saved addresses are read before, not here). */
function searchPlan() {
    const near = [], tails = [];
    for (let b = 1; b <= FLASH_MB; b++) {
        const end = FLASH_BASE + b * MB;
        near.push({ block: b, address: end - SAME_OFFSET });
        for (let a = end - TAIL; ; a += STEP) {
            const at = Math.min(a, end - MARKER_SIZE);
            tails.push({ block: b, address: at });
            if (at === end - MARKER_SIZE) break;
        }
    }
    return near.concat(tails);
}

class Bm3Protocol {
    /** options (optional): { log, dataDir, onProgress(text) } */
    constructor(diag, profiles, config, options) {
        this.diag = diag;
        this.profiles = profiles;
        this.config = config || {};
        this.options = options || {};
        this.rom = null;
        this.profile = null;
        this.markerAddress = null;     // where the marker was read
        this._searched = null;         // the search ran in this app run: its summary (no second search)
        this._canClear = null;         // 2C 03 F301 answered positively (null: not tried yet)
        this._last = Promise.resolve();
    }

    _log(msg) {
        const log = this.options.log;
        if (log && log.info) { try { log.info('bm3 marker: ' + msg); } catch (e) { /* logging never stops the check */ } }
    }

    _progress(text) {
        if (typeof this.options.onProgress === 'function') { try { this.options.onProgress(text); } catch (e) { /* ignore */ } }
    }

    _savedPath() { return this.options.dataDir ? path.join(this.options.dataDir, SAVED_FILE) : null; }

    _savedAddress() {
        const p = this._savedPath();
        if (!p) return null;
        try {
            const s = JSON.parse(fs.readFileSync(p, 'utf8'));
            return s && /^[0-9A-F]{8}$/.test(s.address) ? s.address : null;
        } catch (e) { return null; }
    }

    _save(address, text) {
        const p = this._savedPath();
        if (!p) return;
        try { fs.writeFileSync(p, JSON.stringify({ address, marker: text, savedAt: new Date().toISOString() }, null, 1)); } catch (e) {
            this._log('could not save ' + address + ': ' + String(e && e.message || e));
        }
    }

    /** Define F301 over 255 bytes at `address` and read it. clear: first drop F301's old definition
     * (some DMEs add a new definition to the old one). Only the last 255 bytes of the answer are this
     * address's, should the DME have kept an old definition. */
    async _readAt(address, clear) {
        if (clear && this._canClear !== false) {
            try {
                await this.request(0x2C, [0x03, 0xF3, 0x01], [0x03, 0xF3, 0x01]);
                this._canClear = true;
            } catch (e) {
                if (e && e.noAnswer) throw e;
                if (this._canClear === null) {
                    this._canClear = false;
                    this._log('clearing F301 refused (' + e.message + '); using the last 255 bytes of each answer');
                }
            }
        }
        await this.request(0x2C, [0x02, 0xF3, 0x01, 0x24].concat(addressBytes(address), [0, MARKER_SIZE]), [0x02, 0xF3, 0x01]);
        const reply = await this.request(0x22, [0xF3, 0x01], [0xF3, 0x01]);
        const data = Buffer.from(reply.slice(3));
        return data.length > MARKER_SIZE ? data.slice(data.length - MARKER_SIZE) : data;
    }

    /** Read-only search for the marker. Returns { address, data } or null; this._searched says what was read. */
    async _search(skip) {
        const plan = searchPlan().filter((p) => skip.indexOf(hex32(p.address)) < 0);
        const outOfRange = {};
        let reads = 0, refused = 0, silent = 0;
        this._log('not at the configured place: searching ' + plan.length + ' places in the DME flash (read only)');
        for (let i = 0; i < plan.length; i++) {
            const p = plan[i];
            if (outOfRange[p.block]) continue;
            const address = hex32(p.address);
            if (i % 20 === 0) this._progress('searching the DME for the CustomROM marker · ' + Math.round(100 * i / plan.length) + '%');
            let data;
            try {
                data = await this._readAt(address, true);
                silent = 0;
            } catch (e) {
                if (e && e.noAnswer) {
                    if (++silent >= 3) { this._log('DME stopped answering at ' + address + '; search stopped'); break; }
                    continue;
                }
                if (e && e.nrc === 0x31) { outOfRange[p.block] = true; refused++; continue; }   // no flash there
                if (e && e.nrc != null) { this._log('DME refused the read at ' + address + ' (' + e.message + '); search stopped'); break; }
                throw e;                                                                       // transport gone
            }
            reads++;
            if (data.indexOf(MARKER) >= 0) {
                this._searched = { reads, found: address };
                this._log('found at ' + address + ' after ' + reads + ' reads: ' + markerText(data));
                return { address, data };
            }
        }
        const blocks = Object.keys(outOfRange).map((b) => hex32(FLASH_BASE + (b - 1) * MB).slice(0, 3) + 'xxxxx').join(' ');
        this._searched = { reads, found: null };
        this._log('not found: ' + reads + ' places read' + (refused ? ', no flash (NRC 31) in MB blocks starting ' + blocks : ''));
        return null;
    }

    /** One request at a time: a 0x63 reply carries no address, so two 0x23 reads in flight could
     * take each other's answers. */
    request(sid, data, prefix, timeoutMs) {
        const r = this._last.then(() => this._request(sid, data, prefix, timeoutMs));
        this._last = r.catch(() => {});
        return r;
    }

    async _request(sid, data, prefix, timeoutMs) {
        if (!this.diag.available) throw new Error('MGU diagnostic transport unavailable');
        const reply = await this.diag.physical(DME, sid, data, timeoutMs || 4500,
            (u) => (u[0] === sid + 0x40 && (prefix || []).every((b, i) => u[i + 1] === b))
                || (u[0] === 0x7F && u[1] === sid));
        return positive(reply, sid, prefix);
    }

    /** Find the CustomROM marker and match its ROM key to a known profile. The configured address is
     * read first, exactly as before (one 2C + one 22); a place found by an earlier search is read
     * before it. Only when the marker is not there, or the DME has no memory there (NRC 31), the
     * read-only search runs, once per app run. Any other refusal (security, session) ends the check. */
    async identify() {
        this.profile = null;
        this.rom = null;
        this.markerAddress = null;
        const configured = String(this.config.bm3MarkerAddress || '').toUpperCase();
        addressBytes(configured);
        const saved = this._savedAddress();
        const tried = [];
        let found = null;
        for (const address of [saved, configured]) {
            if (!address || tried.indexOf(address) >= 0) continue;
            let data;
            try {
                data = await this._readAt(address, tried.length > 0);
            } catch (e) {
                tried.push(address);
                if (e && e.nrc === 0x31) { this._log(address + ': no memory there (NRC 31)'); continue; }
                throw e;
            }
            tried.push(address);
            if (data.indexOf(MARKER) >= 0) { found = { address, data }; break; }
            this._log(address + ': no marker, read ' + preview(data));
        }
        if (!found) {
            if (!this._searched) found = await this._search(tried);
            if (!found) {
                const s = this._searched || { reads: 0 };
                throw new Error('BM3 CustomROM marker absent (' + configured + ' and ' + s.reads + ' other places read)');
            }
        }
        this.markerAddress = found.address;
        if (found.address !== configured || !this._searched) this._log('read at ' + found.address + ': ' + markerText(found.data));
        if (found.address !== configured && found.address !== saved) this._save(found.address, markerText(found.data));
        const rom = romFromData(found.data, this.profiles);
        const profile = this.profiles[rom];
        if (!profile || !profile.mapSwActAddr || profile.rom !== rom) throw new Error('BM3 profile unavailable');
        this.rom = rom;
        this.profile = profile;
        return { rom, address: found.address };
    }

    ready() {
        if (!this.profile || !this.rom) throw new Error('DME/BM3 profile not verified');
    }

    memoryWriteService() {
        this.ready();
        const command = String(this.profile.wmbaCmd || '3d').toLowerCase();
        if (command !== '3d' && command !== '3e') throw new Error('unsupported BM3 memory-write command');
        return parseInt(command, 16);
    }

    async writeProfileMemory(address, bytes) {
        const sid = this.memoryWriteService();
        if (!Array.isArray(bytes) || !bytes.length || bytes.length > 0xFF) throw new Error('invalid memory-write data');
        const prefix = sid === 0x3E ? [0x3D] : [];
        return this.request(sid, [0x14].concat(addressBytes(address), [bytes.length], bytes), prefix);
    }

    async currentMap() {
        this.ready();
        const addr = addressBytes(this.profile.mapSwActAddr);
        const r = await this.request(0x23, [0x14].concat(addr, [0x01]), []);
        const slot = r[1];
        if (r.length !== 2 || slot > 3) throw new Error('invalid map readback');
        return slot;
    }

    async setMap(slot) {
        this.ready();
        if (!Number.isInteger(slot) || slot < 0 || slot > 3) throw new Error('invalid map selection');
        await this.writeProfileMemory(this.profile.mapSwActAddr, [slot, 0x01]);
        const actual = await this.currentMap();
        if (actual !== slot) throw new Error('map readback differs: ' + (actual + 1));
        return actual;
    }

    async setFlap(mode) {
        const command = {
            open: [0x60, 0xFD, 0x03, 0x14, 0xFE],
            close: [0x60, 0xFD, 0x03, 0x23, 0x28],
            auto: [0x60, 0xFD, 0x00],
        }[mode];
        if (!command) throw new Error('invalid valve mode');
        await this.request(0x2F, command, command.slice(0, 3), 5500);
        return mode;
    }

    async setAsd(enabled) {
        await this.request(0x2E, [0x5F, 0xFD, enabled ? 0x00 : 0x01], [0x5F, 0xFD], 8000);
        return !!enabled;
    }

    burbleProfile() {
        this.ready();
        const table = this.profile.liveTuneTables && this.profile.liveTuneTables.KF_DZWMIN_SPORT_SOT;
        if (!table || !table.address || !this.profile.burbleActAddr) throw new Error('BM3 burble profile unavailable');
        const factor = Number(table.factor);
        if (!Number.isFinite(factor) || factor <= 0 || 12 * factor > 127) throw new Error('invalid BM3 burble factor');
        return {
            enableAddress: this.profile.burbleActAddr,
            timingAddress: table.address,
            factor,
        };
    }

    async readBurbles() {
        const p = this.burbleProfile();
        const enabled = await this.request(0x23, [0x14].concat(addressBytes(p.enableAddress), [0x01]), []);
        const timing = await this.request(0x23, [0x14].concat(addressBytes(p.timingAddress), [0x18]), []);
        if (enabled.length !== 2 || (enabled[1] !== 0 && enabled[1] !== 1) || timing.length !== 25) {
            throw new Error('invalid burble readback');
        }
        const values = Array.from(timing.slice(1));
        const byte = values[0];
        const signed = byte >= 128 ? byte - 256 : byte;
        const aggression = values.every((v) => v === byte) && signed <= 0 ? -signed / p.factor : null;
        return { enabled: enabled[1] === 1, timing: values, aggression };
    }

    async setBurbles(aggression) {
        if (aggression !== null && (!Number.isInteger(aggression * 2) || aggression < 0 || aggression > 12)) {
            throw new Error('burble aggression must be 0 to 12 in 0.5 steps');
        }
        const p = this.burbleProfile();
        const enabled = aggression !== null;
        const value = enabled ? Math.trunc(-Math.abs(aggression * p.factor)) & 0xFF : 0x00;
        const timing = Array(24).fill(value);
        await this.writeProfileMemory(p.enableAddress, [enabled ? 1 : 0]);
        await this.writeProfileMemory(p.timingAddress, timing);
        const actual = await this.readBurbles();
        if (actual.enabled !== enabled || actual.timing.some((b) => b !== value)) {
            throw new Error('burble readback differs from requested preset');
        }
        return aggression;
    }
}

module.exports = { Bm3Protocol, markerRom, markerText, addressBytes, positive, searchPlan };
