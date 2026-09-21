import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";

export function b64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

export function unb64(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function sha256(data: Uint8Array | string): Buffer {
  return createHash("sha256").update(data).digest();
}

export function hmacSha256(key: Uint8Array, data: Uint8Array | string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

export function deriveKey(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array | string,
  length = 32,
): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

export interface X25519Pair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export function generateEphemeralX25519(): X25519Pair {
  return generateKeyPairSync("x25519");
}

export function exportPublicKey(key: KeyObject): string {
  return b64(key.export({ type: "spki", format: "der" }));
}

export function exportPrivateKey(key: KeyObject): string {
  return b64(key.export({ type: "pkcs8", format: "der" }));
}

export function importPublicKey(value: string): KeyObject {
  return createPublicKey({ key: unb64(value), type: "spki", format: "der" });
}

export function importPrivateKey(value: string): KeyObject {
  return createPrivateKey({ key: unb64(value), type: "pkcs8", format: "der" });
}

export function sharedSecret(privateKey: KeyObject, publicKeyB64: string): Buffer {
  return diffieHellman({ privateKey, publicKey: importPublicKey(publicKeyB64) });
}

export interface AeadBox {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export function aesGcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
  nonce = randomBytes(12),
): AeadBox {
  if (key.byteLength !== 32) throw new Error("AES-256-GCM requires a 32-byte key");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

export function aesGcmDecrypt(
  key: Uint8Array,
  box: AeadBox,
  aad?: Uint8Array,
): Buffer {
  if (key.byteLength !== 32) throw new Error("AES-256-GCM requires a 32-byte key");
  const decipher = createDecipheriv("aes-256-gcm", key, box.nonce);
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(box.tag);
  return Buffer.concat([decipher.update(box.ciphertext), decipher.final()]);
}

export function randomNonce(size = 16): Buffer {
  return randomBytes(size);
}
