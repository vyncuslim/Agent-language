import { canonicalJson, sha256 } from "./crypto.js";
import type { ConceptSourceRecord } from "./types.js";

export type CorpusSourceKind =
  | "dictionary"
  | "lexical-knowledge-base"
  | "encyclopedic"
  | "terminology"
  | "morphology"
  | "entity"
  | "programming"
  | "organization-private"
  | "model-generated"
  | "agent-native";

export type RedistributionPolicy = "private-only" | "metadata-only" | "redistributable";

export interface CorpusSourceDescriptor {
  id: string;
  kind: CorpusSourceKind;
  license: string;
  redistribution: RedistributionPolicy;
  languages?: string[];
  domains?: string[];
  embeddingSpace?: string;
  enabled?: boolean;
  notes?: string;
}

interface CorpusBaseRow {
  /** Private cross-source concept alignment key. Input MUST be grouped/sorted by this field. */
  alignmentKey: string;
  sourceId: string;
  sourceSenseId?: string;
  domains?: string[];
  relations?: Record<string, string[]>;
  /** Private machine-semantic evidence. It is stored only inside encrypted packs. */
  semanticEvidence?: unknown;
  embedding?: number[];
  embeddingSpace?: string;
  metadata?: Record<string, unknown>;
}

export interface CorpusLexemeRow extends CorpusBaseRow {
  kind: "lexeme";
  language: string;
  lexeme: string;
  aliases?: string[];
}

export interface CorpusAgentNativeRow extends CorpusBaseRow {
  kind: "agent-native";
  /** Optional private latent prototype. There need not be a human-language label. */
  prototype?: number[];
}

export type CorpusRow = CorpusLexemeRow | CorpusAgentNativeRow;

export interface CorpusBuildStats {
  sourceRows: number;
  concepts: number;
  lexicalRows: number;
  agentNativeRows: number;
  languages: number;
  surfaceForms: number;
  sources: number;
}

interface ProvenanceItem {
  sourceId: string;
  sourceSenseId?: string;
  license: string;
  redistribution: RedistributionPolicy;
  evidenceDigest?: string;
}

interface MutableCorpusConcept {
  alignmentKey: string;
  aliases: Map<string, Set<string>>;
  relations: Map<string, Set<string>>;
  domains: Set<string>;
  vectors: Array<{ space: string; values: number[] }>;
  provenance: ProvenanceItem[];
  semanticEvidence: Array<{ sourceId: string; record: unknown }>;
  agentNative: boolean;
  metadata: Record<string, unknown>;
}

function norm(value: string, field: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

export function validateCorpusSource(source: CorpusSourceDescriptor): CorpusSourceDescriptor {
  const id = norm(source.id, "source.id");
  const license = norm(source.license, `source ${id} license`);
  if (!source.kind) throw new Error(`source ${id} kind is required`);
  if (!source.redistribution) throw new Error(`source ${id} redistribution policy is required`);
  return {
    ...source,
    id,
    license,
    languages: source.languages?.map((value) => norm(value, "source language")),
    domains: source.domains?.map((value) => norm(value, "source domain")),
    enabled: source.enabled !== false,
  };
}

export function buildCorpusSourceRegistry(
  sources: CorpusSourceDescriptor[],
): Map<string, CorpusSourceDescriptor> {
  const registry = new Map<string, CorpusSourceDescriptor>();
  for (const raw of sources) {
    const source = validateCorpusSource(raw);
    if (registry.has(source.id)) throw new Error(`Duplicate corpus source: ${source.id}`);
    registry.set(source.id, source);
  }
  return registry;
}

function evidenceDigest(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return Buffer.from(sha256(canonicalJson(value))).toString("base64url");
}

function startConcept(
  row: CorpusRow,
  source: CorpusSourceDescriptor,
): MutableCorpusConcept {
  const target: MutableCorpusConcept = {
    alignmentKey: norm(row.alignmentKey, "alignmentKey"),
    aliases: new Map(),
    relations: new Map(),
    domains: new Set([...(source.domains ?? []), ...(row.domains ?? [])].map((v) => norm(v, "domain"))),
    vectors: [],
    provenance: [],
    semanticEvidence: [],
    agentNative: row.kind === "agent-native",
    metadata: { ...(row.metadata ?? {}) },
  };
  mergeRow(target, row, source);
  return target;
}

function mergeRow(
  target: MutableCorpusConcept,
  row: CorpusRow,
  source: CorpusSourceDescriptor,
): void {
  if (norm(row.alignmentKey, "alignmentKey") !== target.alignmentKey) {
    throw new Error("Cannot merge rows with different alignment keys");
  }

  if (row.kind === "lexeme") {
    const language = new Intl.Locale(norm(row.language, "language")).toString();
    const values = [norm(row.lexeme, "lexeme"), ...(row.aliases ?? []).map((v) => norm(v, "alias"))];
    const aliases = target.aliases.get(language) ?? new Set<string>();
    for (const value of values) aliases.add(value);
    target.aliases.set(language, aliases);
  } else {
    target.agentNative = true;
    if (row.prototype) {
      const space = row.embeddingSpace ?? source.embeddingSpace ?? "agent-native-prototype";
      target.vectors.push({ space, values: [...row.prototype] });
    }
  }

  for (const domain of [...(source.domains ?? []), ...(row.domains ?? [])]) {
    target.domains.add(norm(domain, "domain"));
  }

  for (const [name, values] of Object.entries(row.relations ?? {})) {
    const normalizedName = norm(name, "relation");
    const set = target.relations.get(normalizedName) ?? new Set<string>();
    for (const value of values) set.add(norm(value, "relation target"));
    target.relations.set(normalizedName, set);
  }

  if (row.embedding) {
    const space = row.embeddingSpace ?? source.embeddingSpace;
    if (!space) throw new Error(`Embedding space missing for source ${source.id}`);
    target.vectors.push({ space, values: [...row.embedding] });
  }

  if (row.semanticEvidence !== undefined) {
    target.semanticEvidence.push({ sourceId: source.id, record: row.semanticEvidence });
  }

  target.provenance.push({
    sourceId: source.id,
    sourceSenseId: row.sourceSenseId,
    license: source.license,
    redistribution: source.redistribution,
    evidenceDigest: evidenceDigest(row.semanticEvidence),
  });
  target.metadata = { ...target.metadata, ...(row.metadata ?? {}) };
}

function vectorCentroidsBySpace(
  vectors: Array<{ space: string; values: number[] }>,
): Record<string, number[]> {
  const grouped = new Map<string, number[][]>();
  for (const vector of vectors) {
    const bucket = grouped.get(vector.space) ?? [];
    bucket.push(vector.values);
    grouped.set(vector.space, bucket);
  }

  const output: Record<string, number[]> = {};
  for (const [space, values] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dimension = values[0]?.length ?? 0;
    if (dimension === 0 || values.some((vector) => vector.length !== dimension)) {
      throw new Error(`Inconsistent embedding dimensions in space ${space}`);
    }
    const centroid = Array<number>(dimension).fill(0);
    for (const vector of values) {
      for (let i = 0; i < dimension; i += 1) centroid[i] += vector[i];
    }
    output[space] = centroid.map((value) => value / values.length);
  }
  return output;
}

function finalizeConcept(value: MutableCorpusConcept): ConceptSourceRecord {
  const aliases: Record<string, string[]> = {};
  for (const [language, values] of [...value.aliases.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    aliases[language] = [...values].sort();
  }

  const relations: Record<string, string[]> = {};
  for (const [name, values] of [...value.relations.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    relations[name] = [...values].sort();
  }

  const vectorCentroids = vectorCentroidsBySpace(value.vectors);
  const vectorSpaces = Object.keys(vectorCentroids).sort();
  const primaryEmbedding = vectorSpaces.length === 1 ? vectorCentroids[vectorSpaces[0]] : undefined;

  return {
    // Corpus identity is private and stable across later evidence/domain enrichment.
    identityMaterial: {
      schema: "vaml-world-semantic-corpus-identity/0.1",
      privateAlignmentRef: value.alignmentKey,
    },
    semantic: {
      schema: "vaml-world-semantic-corpus/0.1",
      agentNative: value.agentNative,
    },
    aliases: Object.keys(aliases).length ? aliases : undefined,
    relations: Object.keys(relations).length ? relations : undefined,
    domains: [...value.domains].sort(),
    embedding: primaryEmbedding,
    metadata: {
      ...value.metadata,
      corpus: {
        provenance: value.provenance,
        semanticEvidence: value.semanticEvidence,
        vectorSpaces,
        vectorCentroids,
      },
    },
  };
}

/**
 * Streaming private corpus assembler.
 * Rows MUST be grouped and sorted ascending by alignmentKey.
 */
export class WorldSemanticCorpusAssembler {
  private readonly sources: Map<string, CorpusSourceDescriptor>;
  private current?: MutableCorpusConcept;
  private lastCompletedKey?: string;
  private sourceRows = 0;
  private concepts = 0;
  private lexicalRows = 0;
  private agentNativeRows = 0;
  private surfaceForms = 0;
  private readonly languages = new Set<string>();
  private readonly usedSources = new Set<string>();

  constructor(sources: CorpusSourceDescriptor[]) {
    this.sources = buildCorpusSourceRegistry(sources);
  }

  push(row: CorpusRow): ConceptSourceRecord | undefined {
    const source = this.sources.get(norm(row.sourceId, "sourceId"));
    if (!source) throw new Error(`Unknown corpus source: ${row.sourceId}`);
    if (source.enabled === false) throw new Error(`Corpus source is disabled: ${source.id}`);

    const alignmentKey = norm(row.alignmentKey, "alignmentKey");
    this.sourceRows += 1;
    this.usedSources.add(source.id);
    if (row.kind === "lexeme") {
      this.lexicalRows += 1;
      this.surfaceForms += 1 + (row.aliases?.length ?? 0);
      this.languages.add(new Intl.Locale(norm(row.language, "language")).toString());
    } else {
      this.agentNativeRows += 1;
    }

    if (!this.current) {
      if (this.lastCompletedKey && alignmentKey.localeCompare(this.lastCompletedKey) <= 0) {
        throw new Error("Corpus input must be strictly grouped and sorted by alignmentKey");
      }
      this.current = startConcept(row, source);
      return undefined;
    }

    if (alignmentKey === this.current.alignmentKey) {
      mergeRow(this.current, row, source);
      return undefined;
    }

    if (alignmentKey.localeCompare(this.current.alignmentKey) < 0) {
      throw new Error("Corpus input must be sorted by alignmentKey");
    }

    const completed = finalizeConcept(this.current);
    this.lastCompletedKey = this.current.alignmentKey;
    this.concepts += 1;
    this.current = startConcept(row, source);
    return completed;
  }

  finish(): ConceptSourceRecord | undefined {
    if (!this.current) return undefined;
    const completed = finalizeConcept(this.current);
    this.lastCompletedKey = this.current.alignmentKey;
    this.current = undefined;
    this.concepts += 1;
    return completed;
  }

  stats(): CorpusBuildStats {
    return {
      sourceRows: this.sourceRows,
      concepts: this.concepts,
      lexicalRows: this.lexicalRows,
      agentNativeRows: this.agentNativeRows,
      languages: this.languages.size,
      surfaceForms: this.surfaceForms,
      sources: this.usedSources.size,
    };
  }
}
