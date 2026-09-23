/**
 * VAML Text Transport 0.1 — copy/paste armor for encrypted VAML frames.
 *
 * Format: `VAMLTXT1.<base64url>.<crc32hex>` (single line, no whitespace).
 * Transport armor only: the CRC32 checksum detects typos and truncation,
 * never authenticates. Confidentiality/authenticity come exclusively from
 * the VAML session AEAD (`seal`/`open`).
 */

const MAGIC = "VAMLTXT1";
const CRC_HEX_LENGTH = 8;
const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*={0,2}$/;

export interface TextDecodeOptions {
  maxFrameBytes?: number;
}

/**
 * Encode one already-encrypted VAML frame as copy/paste-safe ASCII text.
 * Deterministic: identical input bytes always produce identical text.
 */
export function encodeVamlFrameToText(frame: Uint8Array): string {
  const bytes = Buffer.from(frame);
  if (bytes.length < 1 || bytes.length > DEFAULT_MAX_FRAME_BYTES) {
    throw new Error("Text frame size limit");
  }
  const payload = bytes
    .toString("base64url")
    .replace(/=+$/, "");
  return `${MAGIC}.${payload}.${crc32Hex(bytes)}`;
}

/**
 * Decode text produced by encodeVamlFrameToText(). Surrounding ASCII
 * whitespace (added by copy/paste) is stripped once; anything else
 * malformed fails closed. Never returns partially recovered bytes.
 */
export function decodeVamlFrameFromText(
  text: string,
  options: TextDecodeOptions = {},
): Buffer {
  if (typeof text !== "string") throw new Error("Invalid text frame");
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 16_777_216) {
    throw new Error("Invalid text max frame size");
  }
  const trimmed = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  const parts = trimmed.split(".");
  if (parts.length !== 3) throw new Error("Invalid text frame structure");
  const [magic, payload, checksum] = parts;
  if (magic !== MAGIC) throw new Error("Invalid text frame magic");
  if (!BASE64URL_PATTERN.test(payload)) throw new Error("Invalid text frame encoding");
  if (!/^[0-9a-f]{8}$/.test(checksum)) throw new Error("Invalid text frame checksum");
  // Bound before allocation: 4 base64url chars carry at most 3 bytes.
  if (payload.replace(/=+$/, "").length > Math.ceil(maxFrameBytes / 3) * 4) {
    throw new Error("Text frame size limit");
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(payload, "base64url");
  } catch {
    throw new Error("Invalid text frame encoding");
  }
  if (raw.length < 1 || raw.length > maxFrameBytes) throw new Error("Text frame size limit");
  const expected = checksum;
  const actual = crc32Hex(raw);
  if (expected !== actual) throw new Error("Text CRC mismatch");
  return raw;
}

function crc32Hex(data: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(CRC_HEX_LENGTH, "0");
}
