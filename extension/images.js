import { base64ToBytes, HttpError, readLimited, readStreamLimited } from './http.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_TOTAL = 4 * MAX_IMAGE_BYTES;
export const MAX_REPLY_BYTES = 45 * 1024 * 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function imageFile(bytes, seed = null) {
    if (bytes.length < 33 || bytes.length > MAX_IMAGE_BYTES || PNG.some((byte, i) => bytes[i] !== byte)
        || new TextDecoder().decode(bytes.subarray(12, 16)) !== 'IHDR') {
        throw new HttpError(502, 'NovelAI 回傳無效或過大的 PNG。');
    }
    return { bytes, seed: Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff ? String(seed) : null };
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
export function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP is decoded in memory, never extracted by filename. Bound both metadata and actual inflated bytes. */
async function readZip(bytes, maxImages, signal) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bad = () => new HttpError(502, 'NovelAI ZIP 為空、損毀、加密或超過圖片限制。');
    const u16 = offset => { if (offset < 0 || offset + 2 > bytes.length) throw bad(); return view.getUint16(offset, true); };
    const u32 = offset => { if (offset < 0 || offset + 4 > bytes.length) throw bad(); return view.getUint32(offset, true); };
    let end = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
        if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) { end = offset; break; }
    }
    if (end < 0 || u16(end + 4) || u16(end + 6)) throw bad();
    const count = u16(end + 10), directorySize = u32(end + 12), directory = u32(end + 16);
    if (!count || count > 32 || u16(end + 8) !== count || directory + directorySize > end) throw bad();
    const files = [];
    let cursor = directory, total = 0;
    for (let entry = 0; entry < count; entry++) {
        signal?.throwIfAborted();
        if (cursor + 46 > directory + directorySize || u32(cursor) !== 0x02014b50) throw bad();
        const flags = u16(cursor + 8), method = u16(cursor + 10), checksum = u32(cursor + 16);
        const compressedSize = u32(cursor + 20), size = u32(cursor + 24);
        const nameSize = u16(cursor + 28), extraSize = u16(cursor + 30), commentSize = u16(cursor + 32);
        const local = u32(cursor + 42), nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
        const name = new TextDecoder().decode(nameBytes);
        cursor += 46 + nameSize + extraSize + commentSize;
        if (cursor > directory + directorySize) throw bad();
        if (!/\.png$/i.test(name)) continue;
        if (flags & 0x41 || ![0, 8].includes(method) || !size || size > MAX_IMAGE_BYTES || files.length >= maxImages
            || (method === 0 && compressedSize !== size)) throw bad();
        if (local + 30 > directory || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) throw bad();
        const localNameSize = u16(local + 26), start = local + 30 + localNameSize + u16(local + 28);
        if (localNameSize !== nameSize || start > directory || start + compressedSize > directory
            || nameBytes.some((byte, i) => bytes[local + 30 + i] !== byte)) throw bad();
        const compressed = bytes.subarray(start, start + compressedSize);
        let decoded;
        if (method === 0) decoded = compressed.slice();
        else {
            try {
                const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
                decoded = await readStreamLimited(stream, Math.min(size, MAX_IMAGE_BYTES), signal);
            } catch (error) {
                signal?.throwIfAborted();
                if (error instanceof HttpError) throw error;
                throw new HttpError(502, '無法解壓 NovelAI ZIP；請使用支援 DecompressionStream 的新版瀏覽器。');
            }
        }
        if (decoded.length !== size || crc32(decoded) !== checksum) throw bad();
        total += decoded.length;
        if (total > MAX_IMAGE_TOTAL) throw bad();
        files.push(imageFile(decoded));
    }
    if (cursor !== directory + directorySize || !files.length) throw bad();
    return files;
}

/** Official JSON images and legacy ZIP responses both retain all requested images. */
export async function readImages(response, maxImages = 4, signal) {
    if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > 4) throw new HttpError(400, '圖片數量限制不正確。');
    const bytes = await readLimited(response, MAX_REPLY_BYTES, signal);
    if (response.headers.get('content-type')?.includes('application/json')) {
        let result;
        try { result = JSON.parse(new TextDecoder().decode(bytes)); }
        catch { throw new HttpError(502, 'NovelAI 回傳無效 JSON。'); }
        if (!Array.isArray(result?.images) || !result.images.length || result.images.length > maxImages) {
            throw new HttpError(502, 'NovelAI 未回傳預期的圖片陣列。');
        }
        let total = 0;
        return result.images.map(item => {
            const text = item?.image;
            if (typeof text !== 'string' || !text.length || text.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
                || text.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
                throw new HttpError(502, 'NovelAI 回傳無效 base64 圖片。');
            }
            let decoded;
            try { decoded = base64ToBytes(text); }
            catch { throw new HttpError(502, 'NovelAI 回傳無效 base64 圖片。'); }
            total += decoded.length;
            if (total > MAX_IMAGE_TOTAL) throw new HttpError(502, 'NovelAI 圖片超過總大小限制。');
            return imageFile(decoded, item.seed);
        });
    }
    if (bytes.length >= 4 && new DataView(bytes.buffer).getUint32(0, true) === 0x04034b50) return readZip(bytes, maxImages, signal);
    throw new HttpError(502, 'NovelAI 未回傳 JSON 或 ZIP 圖片。');
}
