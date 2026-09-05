'use strict';

const yauzl = require('yauzl');
const { HttpError } = require('./http.js');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_TOTAL = 4 * MAX_IMAGE_BYTES;
const MAX_REPLY_BYTES = 45 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

async function readLimited(response, limit = MAX_REPLY_BYTES) {
    if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw new HttpError(502, 'NovelAI 回應超過大小限制。');
    }
    if (!response.body) throw new HttpError(502, 'NovelAI 回應為空。');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new HttpError(502, 'NovelAI 回應超過大小限制。');
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
}

function imageFile(buffer, seed = null) {
    if (buffer.length < 33 || buffer.length > MAX_IMAGE_BYTES || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
        || buffer.toString('ascii', 12, 16) !== 'IHDR') {
        throw new HttpError(502, 'NovelAI 回傳無效或過大的 PNG。');
    }
    return { buffer, seed: Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff ? String(seed) : null };
}

function readZip(buffer, maxImages) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
            if (error) return reject(new HttpError(502, 'NovelAI 回傳無效 ZIP。'));
            let stream;
            let settled = false;
            const files = [];
            const fail = () => {
                if (settled) return;
                settled = true;
                stream?.destroy();
                zip.close();
                reject(new HttpError(502, 'NovelAI ZIP 為空、損毀或超過圖片限制。'));
            };
            zip.on('error', fail);
            zip.on('end', () => {
                if (settled) return;
                if (!files.length) return fail();
                settled = true;
                resolve(files);
            });
            if (zip.entryCount > 32) return fail();
            zip.on('entry', (entry) => {
                if (!/\.png$/i.test(entry.fileName)) return zip.readEntry();
                if (files.length >= maxImages || entry.uncompressedSize > MAX_IMAGE_BYTES || entry.isEncrypted()) return fail();
                // Never extract filenames onto the filesystem (including ../ paths).
                zip.openReadStream(entry, (err, source) => {
                    if (err) return fail();
                    stream = source;
                    (async () => {
                        const chunks = [];
                        let size = 0;
                        for await (const chunk of source) {
                            size += chunk.length;
                            if (size > MAX_IMAGE_BYTES) throw new Error('image too large');
                            chunks.push(chunk);
                        }
                        files.push(imageFile(Buffer.concat(chunks, size)));
                        stream = null;
                        if (!settled) zip.readEntry();
                    })().catch(fail);
                });
            });
            zip.readEntry();
        });
    });
}

/** Official JSON response, plus ZIP compatibility for older generation servers. */
async function readImages(response, maxImages = 4) {
    const buffer = await readLimited(response);
    if (response.headers.get('content-type')?.includes('application/json')) {
        let result;
        try { result = JSON.parse(buffer.toString('utf8')); }
        catch { throw new HttpError(502, 'NovelAI 回傳無效 JSON。'); }
        if (!Array.isArray(result?.images) || !result.images.length || result.images.length > maxImages) {
            throw new HttpError(502, 'NovelAI 未回傳預期的圖片陣列。');
        }
        return result.images.map((item) => {
            const data = item?.image;
            if (typeof data !== 'string' || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
                || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
                throw new HttpError(502, 'NovelAI 回傳無效 base64 圖片。');
            }
            return imageFile(Buffer.from(data, 'base64'), item.seed);
        });
    }
    if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) return readZip(buffer, maxImages);
    throw new HttpError(502, 'NovelAI 未回傳 JSON 或 ZIP 圖片。');
}

module.exports = { readImages, readLimited, MAX_IMAGE_TOTAL, MAX_IMAGE_BYTES };
