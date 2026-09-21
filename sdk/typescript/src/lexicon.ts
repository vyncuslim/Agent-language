import { randomBytes } from "node:crypto";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  b64,
  canonicalJson,
  deriveKey,
  hmacSha256,
  sha256,
  unb64,
} from "./crypto.js";
import type {
  CompiledConceptRecord,
  ConceptSourceRecord,
  EncryptedLexiconPack,
  PrivateLexiconPayload,
} from "./types.js";

const PACK_INFO = Buffer.from("VAML-0.2/private-lexicon", "utf8");

export function conceptId(masterSemanticKey: Uint8Array, record: ConceptSourceRecord): string {
  const semanticMaterial = {
    semantic: record.semantic,
    domains: [...(record.domains ?? [])].sort(),
  };
  return b64(hmacSha256(masterSemanticKey, canonicalJson(semanticMaterial)));
}

export function compileConcepts(
  records: ConceptSourceRecord[],
  masterSemanticKey: Uint8Array,
): CompiledConceptRecord[] {
  const seen = new Set<string>();
  const output: CompiledConceptRecord[] = [];

  for (const record of records) {
    const id = conceptId(masterSemanticKey, record);
    if (seen.has(id)) continue;
    seen.add(id);
    output.push({
      conceptId: id,
      semantic: record.semantic,
      aliases: record.aliases,
      domains: [...(record.domains ?? [])].sort(),
      relations: record.relations,
      embedding: record.embedding,
      metadata: record.metadata,
    });
  }

  return output.sort((a, b) => a.conceptId.localeCompare(b.conceptId));
}

export function createPrivatePayload(
  records: ConceptSourceRecord[],
  masterSemanticKey: Uint8Array,
): PrivateLexiconPayload {
  return {
    format: "vaml-private-lexicon",
    version: "0.2",
    createdAt: new Date().toISOString(),
    concepts: compileConcepts(records, masterSemanticKey),
  };
}

export function encryptLexicon(
  payload: PrivateLexiconPayload,
  packSecret: Uint8Array,
): EncryptedLexiconPack {
  const salt = randomBytes(32);
  const key = deriveKey(packSecret, salt, PACK_INFO, 32);
  const plaintext = Buffer.from(canonicalJson(payload), "utf8");
  const packId = b64(sha256(plaintext));
  const aad = Buffer.from(`VAML|0.2|${packId}`, "utf8");
  const box = aesGcmEncrypt(key, plaintext, aad);

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
}

export function decryptLexicon(
  pack: EncryptedLexiconPack,
  packSecret: Uint8Array,
): PrivateLexiconPayload {
  if (pack.format !== "vaml-encrypted-vocab" || pack.version !== "0.2") {
    throw new Error("Unsupported VAML vocabulary pack");
  }

  const salt = unb64(pack.salt);
  const key = deriveKey(packSecret, salt, PACK_INFO, 32);
  const aad = Buffer.from(`VAML|0.2|${pack.packId}`, "utf8");
  const plaintext = aesGcmDecrypt(
    key,
    {
      nonce: unb64(pack.nonce),
      ciphertext: unb64(pack.ciphertext),
      tag: unb64(pack.tag),
    },
    aad,
  );
  const digest = b64(sha256(plaintext));
  if (digest !== pack.packId) throw new Error("Vocabulary pack digest mismatch");

  const parsed = JSON.parse(plaintext.toString("utf8")) as PrivateLexiconPayload;
  if (parsed.format !== "vaml-private-lexicon" || parsed.version !== "0.2") {
    throw new Error("Invalid private vocabulary payload");
  }
  return parsed;
}

export function makePack(
  records: ConceptSourceRecord[],
  masterSemanticKey: Uint8Array,
  packSecret: Uint8Array,
): EncryptedLexiconPack {
  return encryptLexicon(createPrivatePayload(records, masterSemanticKey), packSecret);
}
