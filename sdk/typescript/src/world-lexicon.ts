import { canonicalJson } from "./crypto.js";
import type { ConceptSourceRecord } from "./types.js";

export interface WorldLexemeInput {
  /** Private cross-lingual sense key. Keep source files outside the public repository. */
  conceptKey: string;
  /** BCP-47 language tag, for example en, zh-Hans, ms, ar. */
  language: string;
  /** Surface form used only by private ingress/egress adapters. */
  lexeme: string;
  aliases?: string[];
  /** Optional machine-semantic record. If omitted, the private conceptKey is used as an opaque sense reference. */
  semantic?: unknown;
  relations?: Record<string, string[]>;
  domains?: string[];
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

interface MutableConcept {
  conceptKey: string;
  semantic: unknown;
  aliases: Map<string, Set<string>>;
  relations: Map<string, Set<string>>;
  domains: Set<string>;
  embedding?: number[];
  metadata: Record<string, unknown>;
}

export interface WorldLexiconStats {
  sourceRows: number;
  concepts: number;
  languages: number;
  surfaceForms: number;
}

export function normalizeLanguageTag(value: string): string {
  const raw = value.normalize("NFKC").trim();
  if (!raw) throw new Error("language must not be empty");
  try {
    return new Intl.Locale(raw).toString();
  } catch {
    throw new Error(`Invalid BCP-47 language tag: ${raw}`);
  }
}

export function normalizeLexeme(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new Error("lexeme must not be empty");
  return normalized;
}

function normalizeConceptKey(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new Error("conceptKey must not be empty");
  return normalized;
}

function startConcept(record: WorldLexemeInput): MutableConcept {
  const conceptKey = normalizeConceptKey(record.conceptKey);
  const language = normalizeLanguageTag(record.language);
  const lexeme = normalizeLexeme(record.lexeme);
  const aliases = new Map<string, Set<string>>();
  aliases.set(language, new Set([lexeme, ...(record.aliases ?? []).map(normalizeLexeme)]));

  const relations = new Map<string, Set<string>>();
  for (const [name, values] of Object.entries(record.relations ?? {})) {
    relations.set(name, new Set(values.map((value) => value.normalize("NFKC").trim()).filter(Boolean)));
  }

  return {
    conceptKey,
    semantic: record.semantic ?? { kind: "private-sense-ref", key: conceptKey },
    aliases,
    relations,
    domains: new Set((record.domains ?? []).map((value) => value.normalize("NFKC").trim()).filter(Boolean)),
    embedding: record.embedding ? [...record.embedding] : undefined,
    metadata: { ...(record.metadata ?? {}), sourceConceptKey: conceptKey },
  };
}

function mergeInto(target: MutableConcept, record: WorldLexemeInput): void {
  const language = normalizeLanguageTag(record.language);
  const lexemes = [normalizeLexeme(record.lexeme), ...(record.aliases ?? []).map(normalizeLexeme)];
  const set = target.aliases.get(language) ?? new Set<string>();
  for (const lexeme of lexemes) set.add(lexeme);
  target.aliases.set(language, set);

  if (record.semantic !== undefined && canonicalJson(record.semantic) !== canonicalJson(target.semantic)) {
    throw new Error(`Conflicting semantic records for private concept ${target.conceptKey}`);
  }

  if (record.embedding) {
    if (target.embedding && canonicalJson(target.embedding) !== canonicalJson(record.embedding)) {
      throw new Error(`Conflicting embeddings for private concept ${target.conceptKey}`);
    }
    target.embedding = [...record.embedding];
  }

  for (const domain of record.domains ?? []) {
    const normalized = domain.normalize("NFKC").trim();
    if (normalized) target.domains.add(normalized);
  }

  for (const [name, values] of Object.entries(record.relations ?? {})) {
    const relationSet = target.relations.get(name) ?? new Set<string>();
    for (const value of values) {
      const normalized = value.normalize("NFKC").trim();
      if (normalized) relationSet.add(normalized);
    }
    target.relations.set(name, relationSet);
  }

  target.metadata = { ...target.metadata, ...(record.metadata ?? {}) };
}

function finalizeConcept(value: MutableConcept): ConceptSourceRecord {
  const aliases: Record<string, string[]> = {};
  for (const [language, lexemes] of [...value.aliases.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    aliases[language] = [...lexemes].sort();
  }

  const relations: Record<string, string[]> = {};
  for (const [name, targets] of [...value.relations.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    relations[name] = [...targets].sort();
  }

  return {
    semantic: value.semantic,
    aliases,
    relations: Object.keys(relations).length ? relations : undefined,
    domains: [...value.domains].sort(),
    embedding: value.embedding ? [...value.embedding] : undefined,
    metadata: value.metadata,
  };
}

/**
 * Streaming assembler for very large multilingual lexicons.
 * Input MUST be sorted by conceptKey so a concept can be completed without holding the world lexicon in RAM.
 */
export class WorldConceptAssembler {
  private current?: MutableConcept;
  private lastCompletedKey?: string;
  private sourceRows = 0;
  private conceptCount = 0;
  private readonly languages = new Set<string>();
  private surfaceForms = 0;

  push(record: WorldLexemeInput): ConceptSourceRecord | undefined {
    this.sourceRows += 1;
    const conceptKey = normalizeConceptKey(record.conceptKey);
    const language = normalizeLanguageTag(record.language);
    this.languages.add(language);
    this.surfaceForms += 1 + (record.aliases?.length ?? 0);

    if (!this.current) {
      if (this.lastCompletedKey && conceptKey.localeCompare(this.lastCompletedKey) <= 0) {
        throw new Error("World lexicon input must be strictly grouped and sorted by conceptKey");
      }
      this.current = startConcept(record);
      return undefined;
    }

    if (conceptKey === this.current.conceptKey) {
      mergeInto(this.current, record);
      return undefined;
    }

    if (conceptKey.localeCompare(this.current.conceptKey) < 0) {
      throw new Error("World lexicon input must be sorted by conceptKey");
    }

    const completed = finalizeConcept(this.current);
    this.lastCompletedKey = this.current.conceptKey;
    this.conceptCount += 1;
    this.current = startConcept(record);
    return completed;
  }

  finish(): ConceptSourceRecord | undefined {
    if (!this.current) return undefined;
    const completed = finalizeConcept(this.current);
    this.lastCompletedKey = this.current.conceptKey;
    this.current = undefined;
    this.conceptCount += 1;
    return completed;
  }

  stats(): WorldLexiconStats {
    return {
      sourceRows: this.sourceRows,
      concepts: this.conceptCount,
      languages: this.languages.size,
      surfaceForms: this.surfaceForms,
    };
  }
}
