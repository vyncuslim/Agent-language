import type { CompiledConceptRecord, PrivateLexiconPayload } from "./types.js";
/** Sealed runtime index has no lexical alias adapter. */
export class PrivateSemanticIndex {
  private readonly concepts = new Map<string, CompiledConceptRecord>();
  constructor(payload: PrivateLexiconPayload) {
    for (const c of payload.concepts) {
      if (c.aliases) throw new Error("Aliases belong to private import layer");
      if (this.concepts.has(c.conceptId)) throw new Error("Duplicate concept");
      this.concepts.set(c.conceptId, c);
    }
  }
  has(id: string): boolean {
    return this.concepts.has(id);
  }
  get(id: string): CompiledConceptRecord | undefined {
    return this.concepts.get(id);
  }
  semantic(id: string): unknown {
    const c = this.get(id);
    if (!c) throw new Error("Unknown private concept");
    return c.semantic;
  }
  size(): number {
    return this.concepts.size;
  }
  nearest(
    vector: number[],
    limit = 8,
  ): Array<{ conceptId: string; score: number }> {
    if (limit < 1 || limit > 100 || vector.some((n) => !Number.isFinite(n)))
      throw new Error("Invalid nearest query");
    const best: Array<{ conceptId: string; score: number }> = [];
    for (const c of this.concepts.values()) {
      if (!c.embedding || c.embedding.length !== vector.length) continue;
      let dot = 0,
        a = 0,
        b = 0;
      for (let i = 0; i < vector.length; i++) {
        dot += vector[i] * c.embedding[i];
        a += vector[i] ** 2;
        b += c.embedding[i] ** 2;
      }
      best.push({
        conceptId: c.conceptId,
        score: a && b ? dot / Math.sqrt(a * b) : 0,
      });
      best.sort((x, y) => y.score - x.score);
      if (best.length > limit) best.pop();
    }
    return best;
  }
}
