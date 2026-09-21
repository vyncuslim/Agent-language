import { randomBytes } from "node:crypto";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  assertId,
  assertKey,
  b64,
  canonicalJson,
  deriveKey,
  equalSecret,
  hmacSha256,
  sha256,
  unb64,
} from "./crypto.js";
import { normalizeRecord } from "./ingestion.js";
import type {
  CompiledConceptRecord,
  ConceptSourceRecord,
  EncryptedLexiconPack,
  PrivateLexiconPayload,
} from "./types.js";
const INFO = "VAML-0.2/private-lexicon";
export function conceptId(
  key: Uint8Array,
  record: ConceptSourceRecord,
): string {
  assertKey(key);
  // Domains and lexical expressions are annotations, not identity. Source senses must carry distinct semantics.
  const material =
    record.identityMaterial === undefined
      ? record.semantic
      : {
          identityVersion: "vaml-private-identity/0.1",
          identityMaterial: record.identityMaterial,
        };
  return b64(hmacSha256(key, canonicalJson(material)));
}
function mergeRecord(
  a: CompiledConceptRecord,
  b: CompiledConceptRecord,
): CompiledConceptRecord {
  if (canonicalJson(a.semantic) !== canonicalJson(b.semantic))
    throw new Error("Concept identity conflict");
  const relations: Record<string, string[]> = {};
  for (const r of [a.relations ?? {}, b.relations ?? {}])
    for (const [k, v] of Object.entries(r))
      relations[k] = [...new Set([...(relations[k] ?? []), ...v])].sort();
  if (
    a.embedding &&
    b.embedding &&
    canonicalJson(a.embedding) !== canonicalJson(b.embedding)
  )
    throw new Error("Embedding conflict");
  for (const k of Object.keys(b.metadata ?? {}))
    if (
      k in (a.metadata ?? {}) &&
      canonicalJson(a.metadata![k]) !== canonicalJson(b.metadata![k])
    )
      throw new Error("Metadata conflict");
  return {
    ...a,
    domains: [...new Set([...a.domains, ...b.domains])].sort(),
    relations,
    embedding: a.embedding ?? b.embedding,
    metadata: { ...a.metadata, ...b.metadata },
  };
}
export function compileConcepts(
  records: ConceptSourceRecord[],
  key: Uint8Array,
): CompiledConceptRecord[] {
  const map = new Map<string, CompiledConceptRecord>();
  for (const raw of records)
    for (const r of normalizeRecord(raw)) {
      const id = conceptId(key, r);
      const c: CompiledConceptRecord = {
        conceptId: id,
        semantic: r.semantic,
        domains: r.domains ?? [],
        relations: r.relations,
        embedding: r.embedding,
        metadata: r.metadata,
      };
      const old = map.get(id);
      map.set(id, old ? mergeRecord(old, c) : c);
    }
  return [...map.values()].sort((a, b) => (a.conceptId < b.conceptId ? -1 : 1));
}
export function createPrivatePayload(
  records: ConceptSourceRecord[],
  key: Uint8Array,
): PrivateLexiconPayload {
  return {
    format: "vaml-private-lexicon",
    version: "0.2",
    createdAt: new Date().toISOString(),
    concepts: compileConcepts(records, key),
  };
}
export function mergeLexicons(
  payloads: PrivateLexiconPayload[],
): PrivateLexiconPayload {
  const map = new Map<string, CompiledConceptRecord>();
  for (const p of payloads) {
    validatePayload(p);
    for (const c of p.concepts) {
      const old = map.get(c.conceptId);
      map.set(c.conceptId, old ? mergeRecord(old, c) : c);
    }
  }
  return {
    format: "vaml-private-lexicon",
    version: "0.2",
    createdAt: new Date().toISOString(),
    concepts: [...map.values()],
  };
}
export function validatePayload(p: PrivateLexiconPayload): void {
  if (
    p?.format !== "vaml-private-lexicon" ||
    p.version !== "0.2" ||
    !Array.isArray(p.concepts) ||
    p.concepts.length > 50000
  )
    throw new Error("Invalid private vocabulary payload");
  const seen = new Set<string>();
  for (const c of p.concepts) {
    assertId(c.conceptId);
    if (c.aliases || seen.has(c.conceptId))
      throw new Error("Aliases or duplicate identity in runtime pack");
    normalizeRecord(c);
    seen.add(c.conceptId);
  }
}
export function encryptLexicon(
  payload: PrivateLexiconPayload,
  key: Uint8Array,
): EncryptedLexiconPack {
  assertKey(key);
  validatePayload(payload);
  return encryptDocument(payload, key, INFO);
}
export function encryptDocument(
  value: unknown,
  secret: Uint8Array,
  info: string,
): EncryptedLexiconPack {
  assertKey(secret);
  const salt = randomBytes(32),
    key = deriveKey(secret, salt, info),
    plain = Buffer.from(canonicalJson(value));
  if (plain.length > 64 * 1024 * 1024) throw new Error("Pack size limit");
  const packId = b64(sha256(plain)),
    aad = Buffer.from("VAML|0.2|" + info + "|" + packId);
  try {
    const box = aesGcmEncrypt(key, plain, aad);
    return {
      format: "vaml-encrypted-vocab",
      version: "0.2",
      algorithm: "AES-256-GCM",
      salt: b64(salt),
      nonce: b64(box.nonce),
      ciphertext: b64(box.ciphertext),
      tag: b64(box.tag),
      packId,
    };
  } finally {
    key.fill(0);
    plain.fill(0);
  }
}
export function decryptDocument(
  pack: EncryptedLexiconPack,
  secret: Uint8Array,
  info: string,
): unknown {
  assertKey(secret);
  if (
    pack?.format !== "vaml-encrypted-vocab" ||
    pack.version !== "0.2" ||
    pack.algorithm !== "AES-256-GCM" ||
    typeof pack.ciphertext !== "string" ||
    pack.ciphertext.length > 90 * 1024 * 1024
  )
    throw new Error("Unsupported vocabulary pack");
  assertId(pack.packId);
  const salt = unb64(pack.salt);
  if (salt.length !== 32) throw new Error("Invalid pack salt");
  const key = deriveKey(secret, salt, info);
  let plain: Buffer | undefined;
  try {
    plain = aesGcmDecrypt(
      key,
      {
        nonce: unb64(pack.nonce),
        ciphertext: unb64(pack.ciphertext),
        tag: unb64(pack.tag),
      },
      Buffer.from("VAML|0.2|" + info + "|" + pack.packId),
    );
    if (!equalSecret(sha256(plain), unb64(pack.packId)))
      throw new Error("Pack digest mismatch");
    return JSON.parse(plain.toString("utf8"));
  } finally {
    key.fill(0);
    plain?.fill(0);
  }
}
export function decryptLexicon(
  pack: EncryptedLexiconPack,
  key: Uint8Array,
): PrivateLexiconPayload {
  const p = decryptDocument(pack, key, INFO) as PrivateLexiconPayload;
  validatePayload(p);
  return p;
}
export function makePack(
  records: ConceptSourceRecord[],
  key: Uint8Array,
  secret: Uint8Array,
): EncryptedLexiconPack {
  return encryptLexicon(createPrivatePayload(records, key), secret);
}
