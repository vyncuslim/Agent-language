import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { canonicalJson, sha256 } from "./crypto.js";
import { makePack } from "./lexicon.js";
import {
  WorldSemanticCorpusAssembler,
  buildCorpusSourceRegistry,
  type CorpusRow,
  type CorpusSourceDescriptor,
} from "./corpus.js";
import type { SourcePack1Candidate } from "./source-pack-1.js";
import type { ConceptSourceRecord } from "./types.js";

export interface PrivateCorpusSnapshot {
  id: string;
  sourceId: string;
  path: string;
  sha256: string;
  format: "source-pack-1-candidate-jsonl";
}

export interface PrivateAlignmentManifestRef {
  path: string;
  sha256: string;
}

export interface PrivateCorpusBuildPlan {
  format: "vaml-private-corpus-build-plan";
  version: "0.1";
  runId: string;
  sourceManifest: { path: string; sha256: string };
  snapshots: PrivateCorpusSnapshot[];
  alignmentManifest: PrivateAlignmentManifestRef;
  tempDir: string;
  output: {
    directory: string;
    prefix: string;
    shardSize?: number;
  };
  policy?: {
    minQuality?: number;
    missingAlignment?: "reject" | "skip";
    chunkRows?: number;
    cleanupTemp?: boolean;
  };
}

interface SourceManifestFile {
  format: "vaml-corpus-sources";
  version: "0.1";
  sources: CorpusSourceDescriptor[];
}

interface PrivateAlignmentManifest {
  format: "vaml-private-alignment-manifest";
  version: "0.1";
  prefixChars: number;
  shards: Record<string, { file: string; sha256: string }>;
}

interface PrivateAlignmentShard {
  format: "vaml-private-alignment-shard";
  version: "0.1";
  entries: Record<string, string>;
}

interface PendingRow {
  k: string;
  row: CorpusRow;
  quality: number;
}

interface ShardEntry {
  shard: number;
  file: string;
  packId: string;
  sha256: string;
  concepts: number;
}

export interface PrivateCorpusBuildReceipt {
  format: "vaml-private-corpus-build-receipt";
  version: "0.1";
  runId: string;
  startedAt: string;
  completedAt: string;
  inputDigests: {
    sourceManifest: string;
    alignmentManifest: string;
    snapshots: Array<{ id: string; sourceId: string; sha256: string }>;
  };
  policy: {
    minQuality: number;
    missingAlignment: "reject" | "skip";
    chunkRows: number;
    shardSize: number;
  };
  pipelineStats: {
    candidatesSeen: number;
    qualityRejected: number;
    missingAlignment: number;
    alignedRows: number;
    duplicatesRemoved: number;
    sortedRows: number;
  };
  corpusStats: ReturnType<WorldSemanticCorpusAssembler["stats"]>;
  artifacts: {
    sortedCorpus: { file: string; sha256: string };
    corpusManifest: { file: string; sha256: string };
    encryptedShards: ShardEntry[];
  };
}

function normalized(value: string, field: string): string {
  const output = value.normalize("NFKC").trim();
  if (!output) throw new Error(`${field} must not be empty`);
  return output;
}

function digestString(value: string): string {
  return Buffer.from(sha256(value)).toString("base64url");
}

export function candidateLookupId(candidate: SourcePack1Candidate): string {
  return digestString(
    canonicalJson({
      category: candidate.category,
      sourceId: normalized(candidate.sourceId, "candidate.sourceId"),
      sourceSenseId: normalized(candidate.sourceSenseId, "candidate.sourceSenseId"),
      language: candidate.language?.normalize("NFKC").trim() || null,
      lexeme: candidate.lexeme?.normalize("NFKC").trim() || null,
    }),
  );
}

export function scoreSourcePack1Candidate(candidate: SourcePack1Candidate): number {
  if (!candidate.language?.trim() || !candidate.lexeme?.trim()) return 0;
  let score = 0.5;
  if (candidate.semanticEvidence !== undefined) score += 0.15;
  if ((candidate.aliases?.length ?? 0) > 0) score += 0.05;
  if (Object.keys(candidate.relations ?? {}).length > 0) score += 0.1;
  if ((candidate.domains?.length ?? 0) > 0) score += 0.05;
  if ((candidate.embedding?.length ?? 0) > 0) score += 0.1;
  if (candidate.metadata && Object.keys(candidate.metadata).length > 0) score += 0.05;
  return Math.min(1, Number(score.toFixed(6)));
}

export function privateCorpusRowSortKey(row: CorpusRow): string {
  const identity = digestString(canonicalJson(row));
  return `${row.alignmentKey}\u0000${identity}`;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("base64url");
}

export async function verifySha256File(file: string, expected: string, label = file): Promise<void> {
  const actual = await sha256File(file);
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
}

export function assertOutsidePublicRepository(publicRepoRoot: string, targetPath: string, label: string): void {
  const root = resolve(publicRepoRoot);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`${label} must stay outside the public repository: ${target}`);
  }
}

function validatePlan(plan: PrivateCorpusBuildPlan): void {
  if (plan.format !== "vaml-private-corpus-build-plan" || plan.version !== "0.1") {
    throw new Error("Invalid private corpus build plan");
  }
  normalized(plan.runId, "runId");
  if (!Array.isArray(plan.snapshots) || plan.snapshots.length === 0) {
    throw new Error("Private corpus build plan must contain at least one source snapshot");
  }
  if (!plan.output?.directory || !plan.output.prefix) throw new Error("Build output directory/prefix is required");
}

function parsePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const output = value ?? fallback;
  if (!Number.isInteger(output) || output < 1) throw new Error(`${label} must be a positive integer`);
  return output;
}

function safeChild(base: string, child: string): string {
  const root = resolve(base);
  const target = resolve(root, child);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Alignment shard path escapes its private directory: ${child}`);
  }
  return target;
}

class ShardedPrivateAlignmentResolver {
  private readonly manifest: PrivateAlignmentManifest;
  private readonly baseDir: string;
  private readonly cache = new Map<string, PrivateAlignmentShard>();
  private readonly cacheOrder: string[] = [];
  private readonly maxCachedShards: number;

  constructor(manifest: PrivateAlignmentManifest, manifestPath: string, maxCachedShards = 16) {
    this.manifest = manifest;
    this.baseDir = dirname(resolve(manifestPath));
    this.maxCachedShards = maxCachedShards;
  }

  private async load(prefix: string): Promise<PrivateAlignmentShard | undefined> {
    const cached = this.cache.get(prefix);
    if (cached) return cached;
    const ref = this.manifest.shards[prefix];
    if (!ref) return undefined;
    const file = safeChild(this.baseDir, ref.file);
    await verifySha256File(file, ref.sha256, `alignment shard ${prefix}`);
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as PrivateAlignmentShard;
    if (parsed.format !== "vaml-private-alignment-shard" || parsed.version !== "0.1") {
      throw new Error(`Invalid alignment shard ${prefix}`);
    }
    this.cache.set(prefix, parsed);
    this.cacheOrder.push(prefix);
    while (this.cacheOrder.length > this.maxCachedShards) {
      const evicted = this.cacheOrder.shift();
      if (evicted) this.cache.delete(evicted);
    }
    return parsed;
  }

  async resolve(candidate: SourcePack1Candidate): Promise<string | undefined> {
    const lookupId = candidateLookupId(candidate);
    const prefix = lookupId.slice(0, this.manifest.prefixChars);
    const shard = await this.load(prefix);
    const value = shard?.entries[lookupId];
    return value ? normalized(value, "alignmentKey") : undefined;
  }
}

async function loadSourceManifest(ref: { path: string; sha256: string }): Promise<SourceManifestFile> {
  await verifySha256File(ref.path, ref.sha256, "source manifest");
  const manifest = JSON.parse(await fs.readFile(ref.path, "utf8")) as SourceManifestFile;
  if (manifest.format !== "vaml-corpus-sources" || manifest.version !== "0.1") {
    throw new Error("Invalid corpus source manifest");
  }
  if (!manifest.sources.length) throw new Error("Corpus source manifest must not be empty");
  const registry = buildCorpusSourceRegistry(manifest.sources);
  for (const source of registry.values()) {
    if (/unknown|unresolved|tbd/i.test(source.license)) {
      throw new Error(`Source ${source.id} has unresolved licensing and cannot be built`);
    }
  }
  return manifest;
}

async function loadAlignmentManifest(ref: PrivateAlignmentManifestRef): Promise<PrivateAlignmentManifest> {
  await verifySha256File(ref.path, ref.sha256, "alignment manifest");
  const manifest = JSON.parse(await fs.readFile(ref.path, "utf8")) as PrivateAlignmentManifest;
  if (manifest.format !== "vaml-private-alignment-manifest" || manifest.version !== "0.1") {
    throw new Error("Invalid private alignment manifest");
  }
  if (!Number.isInteger(manifest.prefixChars) || manifest.prefixChars < 1 || manifest.prefixChars > 8) {
    throw new Error("alignment manifest prefixChars must be between 1 and 8");
  }
  return manifest;
}

function candidateToCorpusRow(candidate: SourcePack1Candidate, alignmentKey: string): CorpusRow {
  if (!candidate.language || !candidate.lexeme) {
    throw new Error(`Candidate ${candidate.sourceSenseId} is missing language/lexeme`);
  }
  return {
    kind: "lexeme",
    alignmentKey,
    sourceId: normalized(candidate.sourceId, "candidate.sourceId"),
    sourceSenseId: normalized(candidate.sourceSenseId, "candidate.sourceSenseId"),
    language: normalized(candidate.language, "candidate.language"),
    lexeme: normalized(candidate.lexeme, "candidate.lexeme"),
    aliases: candidate.aliases,
    domains: [...new Set([candidate.category, ...(candidate.domains ?? [])])],
    relations: candidate.relations,
    semanticEvidence: candidate.semanticEvidence,
    embedding: candidate.embedding,
    embeddingSpace: candidate.embeddingSpace,
    metadata: candidate.metadata,
  };
}

async function writeChunk(tempDir: string, chunkIndex: number, rows: PendingRow[]): Promise<string> {
  rows.sort((a, b) => a.k.localeCompare(b.k));
  const path = join(tempDir, `chunk-${String(chunkIndex).padStart(6, "0")}.jsonl`);
  const content = rows.map((item) => JSON.stringify(item)).join("\n") + "\n";
  await fs.writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}

interface ChunkCursor {
  reader: ReturnType<typeof createInterface>;
  iterator: AsyncIterator<string>;
  current?: PendingRow;
}

async function makeChunkCursor(path: string): Promise<ChunkCursor> {
  const reader = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  const iterator = reader[Symbol.asyncIterator]();
  const cursor: ChunkCursor = { reader, iterator };
  const first = await iterator.next();
  if (!first.done) cursor.current = JSON.parse(first.value) as PendingRow;
  return cursor;
}

async function advanceCursor(cursor: ChunkCursor): Promise<void> {
  const next = await cursor.iterator.next();
  cursor.current = next.done ? undefined : (JSON.parse(next.value) as PendingRow);
}

async function mergeChunks(chunkFiles: string[], outputFile: string): Promise<{ rows: number; duplicates: number }> {
  const cursors = await Promise.all(chunkFiles.map(makeChunkCursor));
  const handle = await fs.open(outputFile, "w", 0o600);
  let rows = 0;
  let duplicates = 0;
  let lastKey: string | undefined;
  try {
    while (true) {
      let selected: ChunkCursor | undefined;
      for (const cursor of cursors) {
        if (!cursor.current) continue;
        if (!selected || cursor.current.k.localeCompare(selected.current!.k) < 0) selected = cursor;
      }
      if (!selected?.current) break;
      const item = selected.current;
      if (item.k === lastKey) {
        duplicates += 1;
      } else {
        await handle.write(`${JSON.stringify(item.row)}\n`);
        rows += 1;
        lastKey = item.k;
      }
      await advanceCursor(selected);
    }
  } finally {
    await handle.close();
    for (const cursor of cursors) cursor.reader.close();
  }
  return { rows, duplicates };
}

async function buildEncryptedCorpus(
  sortedCorpusPath: string,
  sourceManifest: SourceManifestFile,
  outputDir: string,
  prefix: string,
  shardSize: number,
  semanticKey: Uint8Array,
  packKey: Uint8Array,
): Promise<{ stats: ReturnType<WorldSemanticCorpusAssembler["stats"]>; shards: ShardEntry[]; manifestFile: string }> {
  const assembler = new WorldSemanticCorpusAssembler(sourceManifest.sources);
  const reader = createInterface({ input: createReadStream(sortedCorpusPath, { encoding: "utf8" }), crlfDelay: Infinity });
  const shards: ShardEntry[] = [];
  let records: ConceptSourceRecord[] = [];
  let shardIndex = 0;
  let writtenConcepts = 0;

  async function flush(): Promise<void> {
    if (!records.length) return;
    const pack = makePack(records, semanticKey, packKey);
    const file = join(outputDir, `${prefix}.${String(shardIndex).padStart(5, "0")}.vocab.json`);
    await fs.writeFile(file, JSON.stringify(pack), { encoding: "utf8", mode: 0o600 });
    shards.push({
      shard: shardIndex,
      file: basename(file),
      packId: pack.packId,
      sha256: await sha256File(file),
      concepts: records.length,
    });
    writtenConcepts += records.length;
    records = [];
    shardIndex += 1;
  }

  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = JSON.parse(trimmed) as CorpusRow;
    const completed = assembler.push(row);
    if (completed) records.push(completed);
    if (records.length >= shardSize) await flush();
  }
  const final = assembler.finish();
  if (final) records.push(final);
  await flush();

  const stats = assembler.stats();
  if (stats.concepts !== writtenConcepts) {
    throw new Error(`Corpus accounting mismatch: assembled=${stats.concepts} written=${writtenConcepts}`);
  }

  const sourcePolicyDigest = digestString(canonicalJson(sourceManifest));
  const manifestFile = join(outputDir, `${prefix}.corpus.manifest.json`);
  await fs.writeFile(
    manifestFile,
    JSON.stringify(
      {
        format: "vaml-world-semantic-corpus",
        version: "0.1",
        createdAt: new Date().toISOString(),
        protocol: "VAML-0.2",
        sourcePolicyDigest,
        stats,
        shards,
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
  return { stats, shards, manifestFile };
}

export async function runPrivateCorpusBuild(
  plan: PrivateCorpusBuildPlan,
  secrets: { semanticKey: Uint8Array; packKey: Uint8Array },
  options: { publicRepoRoot: string },
): Promise<PrivateCorpusBuildReceipt> {
  validatePlan(plan);
  if (secrets.semanticKey.length !== 32 || secrets.packKey.length !== 32) {
    throw new Error("semanticKey and packKey must each be exactly 32 bytes");
  }

  const minQuality = plan.policy?.minQuality ?? 0.5;
  if (!Number.isFinite(minQuality) || minQuality < 0 || minQuality > 1) {
    throw new Error("policy.minQuality must be between 0 and 1");
  }
  const missingAlignment = plan.policy?.missingAlignment ?? "reject";
  const chunkRows = parsePositiveInteger(plan.policy?.chunkRows, 100_000, "policy.chunkRows");
  const shardSize = parsePositiveInteger(plan.output.shardSize, 50_000, "output.shardSize");
  const cleanupTemp = plan.policy?.cleanupTemp !== false;

  const sensitivePaths = [
    [plan.sourceManifest.path, "source manifest"],
    [plan.alignmentManifest.path, "alignment manifest"],
    [plan.tempDir, "temporary directory"],
    [plan.output.directory, "output directory"],
    ...plan.snapshots.map((snapshot) => [snapshot.path, `snapshot ${snapshot.id}`]),
  ] as Array<[string, string]>;
  for (const [path, label] of sensitivePaths) {
    assertOutsidePublicRepository(options.publicRepoRoot, path, label);
  }

  const startedAt = new Date().toISOString();
  const sourceManifest = await loadSourceManifest(plan.sourceManifest);
  const sourceRegistry = buildCorpusSourceRegistry(sourceManifest.sources);
  const alignmentManifest = await loadAlignmentManifest(plan.alignmentManifest);
  const alignmentResolver = new ShardedPrivateAlignmentResolver(alignmentManifest, plan.alignmentManifest.path);

  await fs.mkdir(plan.tempDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(plan.output.directory, { recursive: true, mode: 0o700 });

  const pipelineStats = {
    candidatesSeen: 0,
    qualityRejected: 0,
    missingAlignment: 0,
    alignedRows: 0,
    duplicatesRemoved: 0,
    sortedRows: 0,
  };
  const chunkFiles: string[] = [];
  let pending: PendingRow[] = [];
  let chunkIndex = 0;

  async function flushPending(): Promise<void> {
    if (!pending.length) return;
    chunkFiles.push(await writeChunk(plan.tempDir, chunkIndex, pending));
    pending = [];
    chunkIndex += 1;
  }

  for (const snapshot of plan.snapshots) {
    if (snapshot.format !== "source-pack-1-candidate-jsonl") {
      throw new Error(`Unsupported snapshot format: ${snapshot.format}`);
    }
    await verifySha256File(snapshot.path, snapshot.sha256, `snapshot ${snapshot.id}`);
    const expectedSourceId = normalized(snapshot.sourceId, "snapshot.sourceId");
    const source = sourceRegistry.get(expectedSourceId);
    if (!source || source.enabled === false) throw new Error(`Snapshot source is not enabled: ${expectedSourceId}`);

    const reader = createInterface({ input: createReadStream(snapshot.path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const candidate = JSON.parse(trimmed) as SourcePack1Candidate;
      pipelineStats.candidatesSeen += 1;
      if (normalized(candidate.sourceId, "candidate.sourceId") !== expectedSourceId) {
        throw new Error(`Snapshot ${snapshot.id} emitted candidate for unexpected source ${candidate.sourceId}`);
      }
      const quality = scoreSourcePack1Candidate(candidate);
      if (quality < minQuality) {
        pipelineStats.qualityRejected += 1;
        continue;
      }
      const alignmentKey = await alignmentResolver.resolve(candidate);
      if (!alignmentKey) {
        pipelineStats.missingAlignment += 1;
        if (missingAlignment === "reject") {
          throw new Error(`Missing private alignment for candidate ${candidateLookupId(candidate)}`);
        }
        continue;
      }
      const row = candidateToCorpusRow(candidate, alignmentKey);
      pending.push({ k: privateCorpusRowSortKey(row), row, quality });
      pipelineStats.alignedRows += 1;
      if (pending.length >= chunkRows) await flushPending();
    }
  }
  await flushPending();
  if (!chunkFiles.length) throw new Error("Private corpus build produced no aligned rows");

  const sortedCorpusPath = join(plan.output.directory, `${plan.output.prefix}.corpus.sorted.jsonl`);
  const merged = await mergeChunks(chunkFiles, sortedCorpusPath);
  pipelineStats.duplicatesRemoved = merged.duplicates;
  pipelineStats.sortedRows = merged.rows;

  const built = await buildEncryptedCorpus(
    sortedCorpusPath,
    sourceManifest,
    plan.output.directory,
    plan.output.prefix,
    shardSize,
    secrets.semanticKey,
    secrets.packKey,
  );

  const receipt: PrivateCorpusBuildReceipt = {
    format: "vaml-private-corpus-build-receipt",
    version: "0.1",
    runId: plan.runId,
    startedAt,
    completedAt: new Date().toISOString(),
    inputDigests: {
      sourceManifest: plan.sourceManifest.sha256,
      alignmentManifest: plan.alignmentManifest.sha256,
      snapshots: plan.snapshots.map((snapshot) => ({ id: snapshot.id, sourceId: snapshot.sourceId, sha256: snapshot.sha256 })),
    },
    policy: { minQuality, missingAlignment, chunkRows, shardSize },
    pipelineStats,
    corpusStats: built.stats,
    artifacts: {
      sortedCorpus: { file: basename(sortedCorpusPath), sha256: await sha256File(sortedCorpusPath) },
      corpusManifest: { file: basename(built.manifestFile), sha256: await sha256File(built.manifestFile) },
      encryptedShards: built.shards,
    },
  };

  const receiptPath = join(plan.output.directory, `${plan.output.prefix}.build.receipt.json`);
  await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2), { encoding: "utf8", mode: 0o600 });

  if (cleanupTemp) {
    for (const chunk of chunkFiles) await fs.rm(chunk, { force: true });
  }
  return receipt;
}
