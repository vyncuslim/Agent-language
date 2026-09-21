import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertId, equalSecret, unb64 } from "./crypto.js";
import {
  conceptId,
  createPrivatePayload,
  decryptDocument,
  decryptLexicon,
  encryptDocument,
  encryptLexicon,
  mergeLexicons,
} from "./lexicon.js";
import { normalizeRecord, readSources } from "./ingestion.js";
import { PrivateSemanticIndex } from "./semantic-index.js";
import type { ConceptSourceRecord, EncryptedLexiconPack } from "./types.js";
const INFO = "VAML-0.2/catalog";
interface Shard {
  file: string;
  packId: string;
  count: number;
}
interface Catalog {
  version: 2;
  revision: number;
  count: number;
  buckets: Record<string, Shard>;
}
export function bucketOf(id: string): string {
  assertId(id);
  return unb64(id).subarray(0, 1).toString("hex");
}
export async function buildVocabulary(
  source: string | AsyncIterable<ConceptSourceRecord>,
  out: string,
  semanticKey: Uint8Array,
  packKey: Uint8Array,
  revision = 1,
): Promise<{ catalogId: string; count: number; bytes: number }> {
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error("Invalid catalog revision");
  out = resolve(out);
  await mkdir(out, { recursive: true });
  const stage = await mkdtemp(join(out, ".build-"));
  const buffers = new Map<string, ConceptSourceRecord[]>(),
    fragments = new Map<string, string[]>();
  let buffered = 0;
  let bufferedBytes = 0;
  const bucketBytes = new Map<string, number>();
  async function flush(bucket: string): Promise<void> {
    const records = buffers.get(bucket);
    if (!records?.length) return;
    const pack = encryptLexicon(
      createPrivatePayload(records, semanticKey),
      packKey,
    );
    const files = fragments.get(bucket) ?? [];
    const file = join(stage, bucket + "-" + files.length + ".vocab");
    await writeFile(file, JSON.stringify(pack), { mode: 0o600, flag: "wx" });
    files.push(file);
    fragments.set(bucket, files);
    buffered -= records.length;
    bufferedBytes -= bucketBytes.get(bucket) ?? 0;
    bucketBytes.delete(bucket);
    buffers.delete(bucket);
  }
  try {
    for await (const raw of typeof source === "string"
      ? readSources(source)
      : source) {
      for (const record of normalizeRecord(raw)) {
        const bucket = bucketOf(conceptId(semanticKey, record)),
          records = buffers.get(bucket) ?? [];
        // Aliases are ingestion-only and never persisted in a runtime shard.
        const { aliases: _, ...sealed } = record;
        const recordBytes = Buffer.byteLength(JSON.stringify(sealed));
        if (recordBytes > 1048576) throw new Error("Source record byte limit");
        records.push(sealed);
        bufferedBytes += recordBytes;
        bucketBytes.set(bucket, (bucketBytes.get(bucket) ?? 0) + recordBytes);
        buffers.set(bucket, records);
        buffered++;
        if (records.length >= 1024) await flush(bucket);
        if (buffered >= 16384 || bufferedBytes >= 16 * 1024 * 1024)
          for (const b of [...buffers.keys()]) await flush(b);
      }
    }
    for (const b of [...buffers.keys()]) await flush(b);
    const catalog: Catalog = { version: 2, revision, count: 0, buckets: {} };
    let bytes = 0;
    for (const [bucket, files] of fragments) {
      let merged = createPrivatePayload([], semanticKey);
      for (const file of files) {
        merged = mergeLexicons([
          merged,
          decryptLexicon(JSON.parse(await readFile(file, "utf8")), packKey),
        ]);
        if (merged.concepts.length > 50000)
          throw new Error("Bucket capacity exceeded; repartition deployment");
      }
      const pack = encryptLexicon(merged, packKey),
        file = pack.packId + ".vocab",
        data = JSON.stringify(pack);
      await writeFile(join(out, file), data, { mode: 0o600, flag: "wx" });
      bytes += Buffer.byteLength(data);
      catalog.buckets[bucket] = {
        file,
        packId: pack.packId,
        count: merged.concepts.length,
      };
      catalog.count += merged.concepts.length;
    }
    const envelope = encryptDocument(catalog, packKey, INFO),
      data = JSON.stringify(envelope);
    const file = join(out, envelope.packId + ".catalog.vocab");
    await writeFile(file, data, { mode: 0o600, flag: "wx" });
    bytes += Buffer.byteLength(data);
    return { catalogId: envelope.packId, count: catalog.count, bytes };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
/** Constant-size catalog, lazy shard load, bounded LRU. Does not scan vocabulary on handshake. */
export class ShardedSemanticIndex {
  private readonly catalog: Catalog;
  private readonly cache = new Map<string, PrivateSemanticIndex>();
  private readonly key: Buffer;
  readonly catalogId: string;
  constructor(
    readonly directory: string,
    packKey: Uint8Array,
    expectedCatalogId: string,
    minimumRevision: number,
    readonly cacheShards = 4,
  ) {
    assertId(expectedCatalogId);
    if (
      !Number.isSafeInteger(minimumRevision) ||
      minimumRevision < 1 ||
      !Number.isInteger(cacheShards) ||
      cacheShards < 1 ||
      cacheShards > 256
    )
      throw new Error("Invalid catalog policy");
    this.key = Buffer.from(packKey);
    this.catalogId = expectedCatalogId;
    const file = join(directory, expectedCatalogId + ".catalog.vocab");
    if (statSync(file).size > 1048576) throw new Error("Catalog size limit");
    const envelope = JSON.parse(
      readFileSync(file, "utf8"),
    ) as EncryptedLexiconPack;
    if (!equalSecret(unb64(envelope.packId), unb64(expectedCatalogId)))
      throw new Error("Unpinned catalog");
    const c = decryptDocument(envelope, this.key, INFO) as Catalog;
    if (
      c?.version !== 2 ||
      !Number.isSafeInteger(c.revision) ||
      c.revision < minimumRevision ||
      !c.buckets ||
      Object.keys(c.buckets).length > 256
    )
      throw new Error("Catalog rollback or invalid index");
    let count = 0;
    for (const [bucket, s] of Object.entries(c.buckets)) {
      assertId(s.packId);
      if (
        !/^[0-9a-f]{2}$/.test(bucket) ||
        s.file !== s.packId + ".vocab" ||
        !Number.isInteger(s.count) ||
        s.count < 0 ||
        s.count > 50000
      )
        throw new Error("Invalid shard index");
      count += s.count;
    }
    if (c.count !== count) throw new Error("Invalid catalog count");
    this.catalog = c;
  }
  private shard(bucket: string): PrivateSemanticIndex | undefined {
    const entry = this.catalog.buckets[bucket];
    if (!entry) return;
    let index = this.cache.get(bucket);
    if (index) {
      this.cache.delete(bucket);
      this.cache.set(bucket, index);
      return index;
    }
    const file = join(this.directory, entry.file);
    if (statSync(file).size > 90 * 1024 * 1024)
      throw new Error("Shard size limit");
    const pack = JSON.parse(readFileSync(file, "utf8")) as EncryptedLexiconPack;
    if (!equalSecret(unb64(pack.packId), unb64(entry.packId)))
      throw new Error("Shard substitution");
    const payload = decryptLexicon(pack, this.key);
    if (
      payload.concepts.length !== entry.count ||
      payload.concepts.some((c) => bucketOf(c.conceptId) !== bucket)
    )
      throw new Error("Invalid shard routing");
    index = new PrivateSemanticIndex(payload);
    this.cache.set(bucket, index);
    if (this.cache.size > this.cacheShards)
      this.cache.delete(this.cache.keys().next().value!);
    return index;
  }
  get(id: string) {
    return this.shard(bucketOf(id))?.get(id);
  }
  has(id: string): boolean {
    return this.get(id) !== undefined;
  }
  semantic(id: string): unknown {
    const record = this.get(id);
    if (!record) throw new Error("Unknown private concept");
    return record.semantic;
  }
  size(): number {
    return this.catalog.count;
  }
  loadedShards(): number {
    return this.cache.size;
  }
  verify(): void {
    for (const bucket of Object.keys(this.catalog.buckets)) this.shard(bucket);
  }
  close(): void {
    this.key.fill(0);
    this.cache.clear();
  }
}
