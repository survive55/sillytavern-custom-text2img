import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../images.js';

export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
export const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');
export const PANEL_TOKEN = 'b1.fixture.' + 'a'.repeat(64);
export const JOB_ID = 'a'.repeat(32);

/** Real ZIP fixtures, optionally compressed. No network or real credentials. */
export function makeZip(entries = [{ name: 'image_0.png', data: PNG_BYTES }], { compressed = true } = {}) {
    const local = [], central = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name), data = Buffer.from(entry.data), payload = compressed ? deflateRawSync(data) : data;
        const crc = crc32(data), method = compressed ? 8 : 0;
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(method, 8);
        header.writeUInt32LE(crc, 14); header.writeUInt32LE(payload.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
        local.push(header, name, payload);
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(method, 10);
        cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(payload.length, 20); cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
        central.push(cd, name); offset += header.length + name.length + payload.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}

export function panelLogin(now = Date.now()) {
    return Response.json({ ok: true, protocol: 1, token: PANEL_TOKEN, expires_at: now / 1000 + 3600,
        expires_in: 3600, generation_transports: ['poll'] });
}

export async function finishJob(client, id) {
    for (let i = 0; i < 100; i++) {
        const snapshot = await client.poll(id, 0);
        if (snapshot.finished) return snapshot;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Offline fixture job did not finish');
}
