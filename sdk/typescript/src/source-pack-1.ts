import type { CorpusRow, CorpusSourceDescriptor, RedistributionPolicy } from "./corpus.js";

export type SourcePack1Category = "general-vocabulary" | "morphology" | "entities" | "science-math" | "programming";

export interface SourcePack1Candidate {
  category: SourcePack1Category;
  sourceId: string;
  sourceSenseId: string;
  language?: string;
  lexeme?: string;
  aliases?: string[];
  domains?: string[];
  relations?: Record<string, string[]>;
  semanticEvidence?: unknown;
  embedding?: number[];
  embeddingSpace?: string;
  metadata?: Record<string, unknown>;
}

export interface PrivateSenseAligner {
  resolve(candidate: SourcePack1Candidate): Promise<string> | string;
}

export async function* alignSourcePack1Candidates(
  candidates: AsyncIterable<SourcePack1Candidate> | Iterable<SourcePack1Candidate>,
  aligner: PrivateSenseAligner,
): AsyncGenerator<CorpusRow> {
  for await (const candidate of candidates) {
    const alignmentKey = (await aligner.resolve(candidate)).normalize("NFKC").trim();
    if (!alignmentKey) throw new Error("Private aligner returned an empty alignment key");
    if (!candidate.language || !candidate.lexeme) {
      throw new Error(`Source Pack 1 candidate ${candidate.sourceSenseId} is missing language/lexeme`);
    }
    yield {
      kind: "lexeme",
      alignmentKey,
      sourceId: candidate.sourceId,
      sourceSenseId: candidate.sourceSenseId,
      language: candidate.language,
      lexeme: candidate.lexeme,
      aliases: candidate.aliases,
      domains: [...new Set([candidate.category, ...(candidate.domains ?? [])])],
      relations: candidate.relations,
      semanticEvidence: candidate.semanticEvidence,
      embedding: candidate.embedding,
      embeddingSpace: candidate.embeddingSpace,
      metadata: candidate.metadata,
    };
  }
}

export const SOURCE_PACK_1_DESCRIPTORS: Record<string, CorpusSourceDescriptor> = {
  "wordnet-3.0": {
    id: "wordnet-3.0",
    kind: "lexical-knowledge-base",
    license: "Princeton WordNet 3.0 License",
    redistribution: "redistributable",
    languages: ["en"],
    domains: ["general-vocabulary"],
  },
  "wiktionary-extract": {
    id: "wiktionary-extract",
    kind: "dictionary",
    license: "CC-BY-SA-4.0 AND GFDL-1.1-or-later",
    redistribution: "private-only",
    domains: ["general-vocabulary"],
    notes: "Keep private by default until attribution/share-alike export compliance is explicitly implemented.",
  },
  "wikidata-cc0": {
    id: "wikidata-cc0",
    kind: "encyclopedic",
    license: "CC0-1.0",
    redistribution: "redistributable",
    domains: ["entities", "science-math", "programming"],
  },
};

export function unimorphDescriptor(input: {
  id: string;
  language: string;
  license: string;
  redistribution?: RedistributionPolicy;
}): CorpusSourceDescriptor {
  const license = input.license.normalize("NFKC").trim();
  if (!license || /unknown|unresolved|tbd/i.test(license)) {
    throw new Error("UniMorph source must declare a verified per-dataset license before enablement");
  }
  return {
    id: input.id.normalize("NFKC").trim(),
    kind: "morphology",
    license,
    redistribution: input.redistribution ?? "private-only",
    languages: [input.language],
    domains: ["morphology"],
  };
}

export interface WordNetExtractRecord {
  synset: string;
  pos: string;
  lemmas: string[];
  gloss?: string;
  pointers?: Record<string, string[]>;
}

export function* wordNetCandidates(records: Iterable<WordNetExtractRecord>): Generator<SourcePack1Candidate> {
  for (const record of records) {
    const synset = record.synset.normalize("NFKC").trim();
    if (!synset || record.lemmas.length === 0) continue;
    const [head, ...aliases] = record.lemmas.map((value) => value.normalize("NFKC").trim()).filter(Boolean);
    if (!head) continue;
    yield {
      category: "general-vocabulary",
      sourceId: "wordnet-3.0",
      sourceSenseId: synset,
      language: "en",
      lexeme: head,
      aliases,
      domains: [`pos:${record.pos}`],
      relations: record.pointers,
      semanticEvidence: record.gloss ? { gloss: record.gloss } : undefined,
    };
  }
}

export interface WiktionaryExtractRecord {
  entryId: string;
  senseId: string;
  language: string;
  lemma: string;
  aliases?: string[];
  partOfSpeech?: string;
  gloss?: string;
  forms?: string[];
}

export function* wiktionaryCandidates(records: Iterable<WiktionaryExtractRecord>): Generator<SourcePack1Candidate> {
  for (const record of records) {
    const lemma = record.lemma.normalize("NFKC").trim();
    if (!lemma) continue;
    yield {
      category: "general-vocabulary",
      sourceId: "wiktionary-extract",
      sourceSenseId: `${record.entryId}:${record.senseId}`,
      language: record.language,
      lexeme: lemma,
      aliases: [...new Set([...(record.aliases ?? []), ...(record.forms ?? [])])],
      domains: record.partOfSpeech ? [`pos:${record.partOfSpeech}`] : undefined,
      semanticEvidence: record.gloss ? { gloss: record.gloss } : undefined,
    };
  }
}

export interface UniMorphRecord {
  lemma: string;
  form: string;
  features: string;
}

export function* uniMorphCandidates(
  records: Iterable<UniMorphRecord>,
  sourceId: string,
  language: string,
): Generator<SourcePack1Candidate> {
  for (const record of records) {
    const lemma = record.lemma.normalize("NFKC").trim();
    const form = record.form.normalize("NFKC").trim();
    if (!lemma || !form) continue;
    yield {
      category: "morphology",
      sourceId,
      sourceSenseId: `${language}:${lemma}:${record.features}`,
      language,
      lexeme: lemma,
      aliases: form === lemma ? [] : [form],
      domains: ["morphology", `features:${record.features}`],
      semanticEvidence: { lemma, form, features: record.features },
    };
  }
}

export interface WikidataExtractRecord {
  id: string;
  labels: Record<string, string>;
  aliases?: Record<string, string[]>;
  descriptions?: Record<string, string>;
  instanceOf?: string[];
  subclassOf?: string[];
  category: "entities" | "science-math" | "programming";
}

export function* wikidataCandidates(records: Iterable<WikidataExtractRecord>): Generator<SourcePack1Candidate> {
  for (const record of records) {
    for (const [language, labelRaw] of Object.entries(record.labels)) {
      const label = labelRaw.normalize("NFKC").trim();
      if (!label) continue;
      yield {
        category: record.category,
        sourceId: "wikidata-cc0",
        sourceSenseId: record.id,
        language,
        lexeme: label,
        aliases: record.aliases?.[language],
        relations: {
          ...(record.instanceOf?.length ? { instanceOf: record.instanceOf } : {}),
          ...(record.subclassOf?.length ? { subclassOf: record.subclassOf } : {}),
        },
        semanticEvidence: record.descriptions?.[language] ? { description: record.descriptions[language] } : undefined,
        metadata: { wikidataId: record.id, profile: record.category },
      };
    }
  }
}
