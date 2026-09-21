import type { CompiledConceptRecord, PrivateLexiconPayload } from "./types.js";

function normalizeLexeme(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("und");
}

export class PrivateSemanticIndex {
  private readonly concepts = new Map<string, CompiledConceptRecord>();
  private readonly aliases = new Map<string, Set<string>>();

  constructor(readonly payload: PrivateLexiconPayload) {
    for (const concept of payload.concepts) {
      this.concepts.set(concept.conceptId, concept);
      for (const [language, values] of Object.entries(concept.aliases ?? {})) {
        for (const value of values) {
          const key = `${language}|${normalizeLexeme(value)}`;
          const set = this.aliases.get(key) ?? new Set<string>();
          set.add(concept.conceptId);
          this.aliases.set(key, set);
        }
      }
    }
  }

  get(conceptId: string): CompiledConceptRecord | undefined {
    return this.concepts.get(conceptId);
  }

  resolveAlias(language: string, lexeme: string): string[] {
    return [...(this.aliases.get(`${language}|${normalizeLexeme(lexeme)}`) ?? [])];
  }

  nearest(vector: number[], limit = 8): Array<{ conceptId: string; score: number }> {
    const scored: Array<{ conceptId: string; score: number }> = [];
    for (const concept of this.concepts.values()) {
      if (!concept.embedding || concept.embedding.length !== vector.length) continue;
      scored.push({ conceptId: concept.conceptId, score: cosine(vector, concept.embedding) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Returns machine semantic material to an authorized agent adapter. */
  semantic(conceptId: string): unknown {
    const concept = this.concepts.get(conceptId);
    if (!concept) throw new Error(`Unknown private concept: ${conceptId}`);
    return concept.semantic;
  }

  size(): number {
    return this.concepts.size;
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (aa === 0 || bb === 0) return 0;
  return dot / Math.sqrt(aa * bb);
}
