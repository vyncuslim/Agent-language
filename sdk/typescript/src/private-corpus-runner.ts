import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { b64, canonicalJson, sha256 } from "./crypto.js";
import {
  WorldSemanticCorpusAssembler,
  buildCorpusSourceRegistry,
  type CorpusRow,
  type CorpusSourceDescriptor,
} from "./corpus.js";
import type { SourcePack1Candidate } from "./source-pack-1.js";
import type { ConceptSourceRecord } from "./types.js";
import { buildVocabulary } from "./vocabulary.js";

const MAX_SOURCE_LINE_BYTES = 1024 * 1024;
const MAX_INTERNAL_LINE_BYTES = 2 * 1024 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;

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
    revision?: number;
  };
  policy?: {
    minQuality?: number;
    missingAlignment?: "reject" | "skip";
    chunkRows?: number;
    mergeFanIn?: number;
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
  alignmentKey: string;
  digest: string;
  row: CorpusRow;
}

interface ChunkCursor {
  reader: ReturnType<typeof createInterface>;
  iterator: AsyncIterator<string>;
  current?: PendingRow;
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
    mergeFanIn: number;
    revision: number;
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
    vocabulary: {
      directory: string;
      catalogId: string;
      revision: number;
      count: number;
      bytes: number;
      catalogFile: string;
      catalogSha256: string;
      files: Array<{ file: string; sha256: string; bytes: number }>;
    };
  };
}

function normalized(value: string, field: string): string {
  const output = value.normalize("NFKC").trim();
  if (!output) throw new Error(`${field} must not be empty`);
  return output;
}

function digestString(value: string): string {
  return b64(sha256(value));
}

function sortedUnique(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const output = [...new Set(values.map((value) => value.normalize("NFKC").trim()).filter(Boolean))].sort();
  return output.length ? output : undefined;
}

function normalizeRelations(relations: Record<string, string[]> | undefined): Record<string, string[]> | undefined {
  if (!relations) return undefined;
  const output: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(relations).sort(([a], [b]) => a.localeCompare(b))) {
    const key = normalized(name, "relation");
    const items = sortedUnique(values);
    if (items?.length) output[key] = items;
  }
  return Object.keys(output).length ? output : undefined;
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

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("base64url");
}

export async function verifySha256File(file: string, expected: string, label = file): Promise<void> {
  if (!OPAQUE_ID.test(expected)) throw new Error(`${label} has invalid SHA-256 encoding`);
  const actual = await sha256File(file);
  if (actual !== expected) throw new Error(`${label} SHA-256 mismatch`);
}

export function assertOutsidePublicRepository(publicRepoRoot: string, targetPath: string, label: string): void {
  const root = resolve(publicRepoRoot);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`${label} must stay outside the public repository`);
  }
}

function pathsOverlap(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  const lr = relative(left, right);
  const rl = relative(right, left);
  return lr === "" || (!lr.startsWith("..") && !isAbsolute(lr)) || (!rl.startsWith("..") && !isAbsolute(rl));
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(plan.output.prefix)) {
    throw new Error("output.prefix must start with an alphanumeric character and contain only safe filename characters");
  }
  if (pathsOverlap(plan.tempDir, plan.output.directory)) {
    throw new Error("Temporary and output directories must not overlap");
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string, maximum?: number): number {
  const output = value ?? fallback;
  if (!Number.isInteger(output) || output < 1 || (maximum !== undefined && output > maximum)) {
    throw new Error(`${label} must be a valid positive integer`);
  }
  return output;
}

function safeChild(base: string, child: string): string {
  const root = resolve(base);
  const target = resolve(root, child);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Alignment shard path escapes its private directory");
  }
  return target;
}

async function ensureEmptyDirectory(path: string, label: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(path);
  if (entries.length) throw new Error(`${label} must be empty before build`);
}

class ShardedPrivateAlignmentResolver {
  private readonly baseDir: string;
  private readonly cache = new Map<string, PrivateAlignmentShard>();
  private readonly order: string[] = [];

  constructor(
    private readonly manifest: PrivateAlignmentManifest,
    manifestPath: string,
    private readonly maxCachedShards = 16,
  ) {
    this.baseDir = dirname(resolve(manifestPath));
  }

  private async load(prefix: string): Promise<PrivateAlignmentShard | undefined> {
    const cached = this.cache.get(prefix);
    if (cached) {
      const index = this.order.indexOf(prefix);
      if (index >= 0) this.order.splice(index, 1);
      this.order.push(prefix);
      return cached;
    }
    const ref = this.manifest.shards[prefix];
    if (!ref) return undefined;
    const file = safeChild(this.baseDir, ref.file);
    await verifySha256File(file, ref.sha256, `alignment shard ${prefix}`);
    if ((await fs.stat(file)).size > 64 * 1024 * 1024) throw new Error("Alignment shard size limit");
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as PrivateAlignmentShard;
    if (parsed.format !== "vaml-private-alignment-shard" || parsed.version !== "0.1" || !parsed.entries) {
      throw new Error("Invalid private alignment shard");
    }
    for (const [lookupId, alignmentKey] of Object.entries(parsed.entries)) {
      if (!OPAQUE_ID.test(lookupId) || !alignmentKey.trim()) throw new Error("Invalid private alignment entry");
    }
    this.cache.set(prefix, parsed);
    this.order.push(prefix);
    while (this.order.length > this.maxCachedShards) {
      const evicted = this.order.shift();
      if (evicted) this.cache.delete(evicted);
    }
    return parsed;
  }

  async resolve(candidate: SourcePack1Candidate): Promise<string | undefined> {
    const lookupId = candidateLookupId(candidate);
    const prefix = lookupId.slice(0, this.manifest.prefixChars);
    const value = (await this.load(prefix))?.entries[lookupId];
    return value ? normalized(value, "alignmentKey") : undefined;
  }
}

async function loadSourceManifest(ref: { path: string; sha256: string }): Promise<SourceManifestFile> {
  await verifySha256File(ref.path, ref.sha256, "source manifest");
  if ((await fs.stat(ref.path)).size > 1024 * 1024) throw new Error("Source manifest size limit");
  const manifest = JSON.parse(await fs.readFile(ref.path, "utf8")) as SourceManifestFile;
  if (manifest.format !== "vaml-corpus-sources" || manifest.version !== "0.1" || !Array.isArray(manifest.sources)) {
    throw new Error("Invalid corpus source manifest");
  }
  if (!manifest.sources.length || manifest.sources.length > 10_000) throw new Error("Invalid corpus source count");
  const registry = buildCorpusSourceRegistry(manifest.sources);
  for (const source of registry.values()) {
    if (/unknown|unresolved|tbd/i.test(source.license)) throw new Error(`Source ${source.id} has unresolved licensing`);
  }
  return manifest;
}

async function loadAlignmentManifest(ref: PrivateAlignmentManifestRef): Promise<PrivateAlignmentManifest> {
  await verifySha256File(ref.path, ref.sha256, "alignment manifest");
  if ((await fs.stat(ref.path)).size > 8 * 1024 * 1024) throw new Error("Alignment manifest size limit");
  const manifest = JSON.parse(await fs.readFile(ref.path, "utf8")) as PrivateAlignmentManifest;
  if (manifest.format !== "vaml-private-alignment-manifest" || manifest.version !== "0.1") {
    throw new Error("Invalid private alignment manifest");
  }
  if (!Number.isInteger(manifest.prefixChars) || manifest.prefixChars < 1 || manifest.prefixChars > 8) {
    throw new Error("alignment manifest prefixChars must be between 1 and 8");
  }
  const entries = Object.entries(manifest.shards ?? {});
  if (!entries.length || entries.length > 65_536) throw new Error("Invalid alignment shard index");
  const prefixPattern = new RegExp(`^[A-Za-z0-9_-]{${manifest.prefixChars}}$`);
  for (const [prefix, ref] of entries) {
    if (!prefixPattern.test(prefix) || !ref.file || !OPAQUE_ID.test(ref.sha256)) throw new Error("Invalid alignment shard reference");
  }
  return manifest;
}

function candidateToCorpusRow(candidate: SourcePack1Candidate, alignmentKey: string): CorpusRow {
  if (!candidate.language || !candidate.lexeme) throw new Error("Candidate is missing language/lexeme");
  if (candidate.embedding?.some((value) => !Number.isFinite(value))) throw new Error("Invalid candidate embedding");
  return {
    kind: "lexeme",
    alignmentKey,
    sourceId: normalized(candidate.sourceId, "candidate.sourceId"),
    sourceSenseId: normalized(candidate.sourceSenseId, "candidate.sourceSenseId"),
    language: normalized(candidate.language, "candidate.language"),
    lexeme: normalized(candidate.lexeme, "candidate.lexeme"),
    aliases: sortedUnique(candidate.aliases),
    domains: sortedUnique([candidate.category, ...(candidate.domains ?? [])]),
    relations: normalizeRelations(candidate.relations),
    semanticEvidence: candidate.semanticEvidence,
    embedding: candidate.embedding ? [...candidate.embedding] : undefined,
    embeddingSpace: candidate.embeddingSpace?.normalize("NFKC").trim() || undefined,
    metadata: candidate.metadata,
  };
}

function rowItem(row: CorpusRow): PendingRow {
  return { alignmentKey: row.alignmentKey, digest: digestString(canonicalJson(row)), row };
}

function compareItems(a: PendingRow, b: PendingRow): number {
  return a.alignmentKey.localeCompare(b.alignmentKey) || a.digest.localeCompare(b.digest);
}

async function writeChunk(tempDir: string, index: number, rows: PendingRow[]): Promise<string> {
  rows.sort(compareItems);
  const file = join(tempDir, `chunk-${String(index).padStart(8, "0")}.jsonl`);
  await fs.writeFile(file, rows.map((item) => JSON.stringify(item)).join("\n") + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return file;
}

async function makeCursor(file: string): Promise<ChunkCursor> {
  const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const iterator = reader[Symbol.asyncIterator]();
  const cursor: ChunkCursor = { reader, iterator };
  const first = await iterator.next();
  if (!first.done) cursor.current = JSON.parse(first.value) as PendingRow;
  return cursor;
}

async function advance(cursor: ChunkCursor): Promise<void> {
  const next = await cursor.iterator.next();
  cursor.current = next.done ? undefined : (JSON.parse(next.value) as PendingRow);
}

async function mergeGroup(
  files: string[],
  output: string,
  emitCorpusRows: boolean,
): Promise<{ rows: number; duplicates: number }> {
  const cursors = await Promise.all(files.map(makeCursor));
  const handle = await fs.open(output, "wx", 0o600);
  let rows = 0;
  let duplicates = 0;
  let lastAlignment: string | undefined;
  let lastDigest: string | undefined;
  try {
    while (true) {
      let selected: ChunkCursor | undefined;
      for (const cursor of cursors) {
        if (!cursor.current) continue;
        if (!selected || compareItems(cursor.current, selected.current!) < 0) selected = cursor;
      }
      if (!selected?.current) break;
      const item = selected.current;
      if (item.alignmentKey === lastAlignment && item.digest === lastDigest) {
        duplicates += 1;
      } else {
        const line = JSON.stringify(emitCorpusRows ? item.row : item);
        const limit = emitCorpusRows ? MAX_SOURCE_LINE_BYTES : MAX_INTERNAL_LINE_BYTES;
        if (Buffer.byteLength(line) > limit) throw new Error("Normalized row size limit");
        await handle.write(line + "\n");
        rows += 1;
        lastAlignment = item.alignmentKey;
        lastDigest = item.digest;
      }
      await advance(selected);
    }
  } finally {
    await handle.close();
    for (const cursor of cursors) cursor.reader.close();
  }
  return { rows, duplicates };
}

async function externalSort(
  chunks: string[],
  tempDir: string,
  finalFile: string,
  fanIn: number,
): Promise<{ rows: number; duplicates: number }> {
  let generation = 0;
  let files = [...chunks];
  let duplicates = 0;
  while (files.length > fanIn) {
    const next: string[] = [];
    for (let i = 0; i < files.length; i += fanIn) {
      const group = files.slice(i, i + fanIn);
      const output = join(tempDir, `merge-${generation}-${String(next.length).padStart(6, "0")}.jsonl`);
      const result = await mergeGroup(group, output, false);
      duplicates += result.duplicates;
      next.push(output);
      for (const file of group) await fs.rm(file, { force: true });
    }
    files = next;
    generation += 1;
  }
  const merged = await mergeGroup(files, finalFile, true);
  duplicates += merged.duplicates;
  for (const file of files) await fs.rm(file, { force: true });
  return { rows: merged.rows, duplicates };
}

async function* lines(file: string): AsyncGenerator<string> {
  const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (Buffer.byteLength(line) > MAX_SOURCE_LINE_BYTES) throw new Error("Source line limit");
      if (line.trim()) yield line;
    }
  } finally {
    reader.close();
  }
}

async function listVocabularyArtifacts(directory: string): Promise<Array<{ file: string; sha256: string; bytes: number }>> {
  const output: Array<{ file: string; sha256: string; bytes: number }> = [];
  for (const file of (await fs.readdir(directory)).filter((name) => name.endsWith(".vocab")).sort()) {
    const path = join(directory, file);
    const stat = await fs.stat(path);
    output.push({ file, sha256: await sha256File(path), bytes: stat.size });
  }
  return output;
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
  if (!Number.isFinite(minQuality) || minQuality < 0 || minQuality > 1) throw new Error("Invalid minQuality");
  const missingAlignment = plan.policy?.missingAlignment ?? "reject";
  const chunkRows = positiveInteger(plan.policy?.chunkRows, 100_000, "chunkRows", 1_000_000);
  const mergeFanIn = positiveInteger(plan.policy?.mergeFanIn, 64, "mergeFanIn", 256);
  const revision = positiveInteger(plan.output.revision, 1, "revision");
  const cleanupTemp = plan.policy?.cleanupTemp !== false;

  const sensitivePaths = [
    [plan.sourceManifest.path, "source manifest"],
    [plan.alignmentManifest.path, "alignment manifest"],
    [plan.tempDir, "temporary directory"],
    [plan.output.directory, "output directory"],
    ...plan.snapshots.map((snapshot) => [snapshot.path, `snapshot ${snapshot.id}`]),
  ] as Array<[string, string]>;
  for (const [path, label] of sensitivePaths) assertOutsidePublicRepository(options.publicRepoRoot, path, label);

  const startedAt = new Date().toISOString();
  const sourceManifest = await loadSourceManifest(plan.sourceManifest);
  const sourceRegistry = buildCorpusSourceRegistry(sourceManifest.sources);
  const alignmentManifest = await loadAlignmentManifest(plan.alignmentManifest);
  const alignmentResolver = new ShardedPrivateAlignmentResolver(alignmentManifest, plan.alignmentManifest.path);

  await ensureEmptyDirectory(plan.tempDir, "temporary directory");
  await ensureEmptyDirectory(plan.output.directory, "output directory");

  const stats = {
    candidatesSeen: 0,
    qualityRejected: 0,
    missingAlignment: 0,
    alignedRows: 0,
    duplicatesRemoved: 0,
    sortedRows: 0,
  };
  let pending: PendingRow[] = [];
  const chunks: string[] = [];
  let chunkIndex = 0;

  async function flushPending(): Promise<void> {
    if (!pending.length) return;
    chunks.push(await writeChunk(plan.tempDir, chunkIndex++, pending));
    pending = [];
  }

  for (const snapshot of plan.snapshots) {
    if (snapshot.format !== "source-pack-1-candidate-jsonl") throw new Error("Unsupported snapshot format");
    await verifySha256File(snapshot.path, snapshot.sha256, `snapshot ${snapshot.id}`);
    const expectedSourceId = normalized(snapshot.sourceId, "snapshot.sourceId");
    const source = sourceRegistry.get(expectedSourceId);
    if (!source || source.enabled === false) throw new Error(`Snapshot source is not enabled: ${expectedSourceId}`);

    for await (const line of lines(snapshot.path)) {
      const candidate = JSON.parse(line) as SourcePack1Candidate;
      stats.candidatesSeen += 1;
      if (normalized(candidate.sourceId, "candidate.sourceId") !== expectedSourceId) {
        throw new Error("Snapshot emitted a candidate for another source");
      }
      const quality = scoreSourcePack1Candidate(candidate);
      if (quality < minQuality) {
        stats.qualityRejected += 1;
        continue;
      }
      const alignmentKey = await alignmentResolver.resolve(candidate);
      if (!alignmentKey) {
        stats.missingAlignment += 1;
        if (missingAlignment === "reject") throw new Error(`Missing private alignment for ${candidateLookupId(candidate)}`);
        continue;
      }
      pending.push(rowItem(candidateToCorpusRow(candidate, alignmentKey)));
      stats.alignedRows += 1;
      if (pending.length >= chunkRows) await flushPending();
    }
  }
  await flushPending();
  if (!chunks.length) throw new Error("Private corpus build produced no aligned rows");

  const sortedCorpus = join(plan.output.directory, `${plan.output.prefix}.corpus.sorted.jsonl`);
  const sorted = await externalSort(chunks, plan.tempDir, sortedCorpus, mergeFanIn);
  stats.duplicatesRemoved = sorted.duplicates;
  stats.sortedRows = sorted.rows;

  const assembler = new WorldSemanticCorpusAssembler(sourceManifest.sources);
  const sourcePolicyDigest = b64(sha256(canonicalJson(sourceManifest)));
  async function* records(): AsyncGenerator<ConceptSourceRecord> {
    for await (const line of lines(sortedCorpus)) {
      const row = JSON.parse(line) as CorpusRow;
      if (row.kind !== "lexeme" && row.kind !== "agent-native") throw new Error("Invalid sorted corpus row");
      const record = assembler.push(row);
      if (record) {
        record.metadata = { ...record.metadata, sourcePolicyDigest };
        yield record;
      }
    }
    const last = assembler.finish();
    if (last) {
      last.metadata = { ...last.metadata, sourcePolicyDigest };
      yield last;
    }
  }

  const vocabularyDirectory = join(plan.output.directory, "vocabulary");
  await ensureEmptyDirectory(vocabularyDirectory, "vocabulary directory");
  const vocabulary = await buildVocabulary(records(), vocabularyDirectory, secrets.semanticKey, secrets.packKey, revision);
  const corpusStats = assembler.stats();
  if (corpusStats.concepts !== vocabulary.count) throw new Error("Corpus/vocabulary accounting mismatch");

  const catalogFile = `${vocabulary.catalogId}.catalog.vocab`;
  const catalogPath = join(vocabularyDirectory, catalogFile);
  const files = await listVocabularyArtifacts(vocabularyDirectory);
  if (!files.some((file) => file.file === catalogFile)) throw new Error("Vocabulary catalog artifact missing");

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
    policy: { minQuality, missingAlignment, chunkRows, mergeFanIn, revision },
    pipelineStats: stats,
    corpusStats,
    artifacts: {
      sortedCorpus: { file: basename(sortedCorpus), sha256: await sha256File(sortedCorpus) },
      vocabulary: {
        directory: "vocabulary",
        catalogId: vocabulary.catalogId,
        revision,
        count: vocabulary.count,
        bytes: vocabulary.bytes,
        catalogFile,
        catalogSha256: await sha256File(catalogPath),
        files,
      },
    },
  };

  await fs.writeFile(join(plan.output.directory, `${plan.output.prefix}.build.receipt.json`), JSON.stringify(receipt, null, 2), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });

  if (cleanupTemp) await fs.rm(plan.tempDir, { recursive: true, force: true });
  return receipt;
}
