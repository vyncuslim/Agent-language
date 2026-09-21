import { canonicalJson } from "./crypto.js";
import type { CompiledConceptRecord } from "./types.js";

export interface SemanticResolver {
  get(conceptId: string): CompiledConceptRecord | undefined;
  /** Only an explicitly supplied private ingestion adapter may implement this. */
  resolveAlias?(language: string, lexeme: string): string[];
  nearest(vector: number[], limit?: number): Array<{ conceptId: string; score: number }>;
}

export interface AgentObservation {
  conceptId?: string;
  vector?: number[];
  language?: string;
  lexeme?: string;
}

export interface ConceptCandidate {
  conceptId: string;
  confidence: number;
  source: "exact" | "private-alias" | "embedding" | "association";
}

export interface LearnerSnapshot {
  format: "vaml-agent-learning-state";
  version: "0.2";
  exposures: Array<[string, number]>;
  associations: Array<[string, string, number]>;
}

/**
 * Runtime-local learner over an authorized semantic resolver.
 * PrivateSemanticIndex satisfies this interface for small/reference deployments.
 * Large deployments can provide a sharded or ANN-backed resolver without changing VAML.
 */
export class AgentSemanticLearner {
  private readonly exposures = new Map<string, number>();
  private readonly associations = new Map<string, number>();

  constructor(readonly index: SemanticResolver) {}

  resolve(observation: AgentObservation, limit = 8): ConceptCandidate[] {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    const merged = new Map<string, ConceptCandidate>();

    const add = (candidate: ConceptCandidate): void => {
      const previous = merged.get(candidate.conceptId);
      if (!previous || candidate.confidence > previous.confidence) merged.set(candidate.conceptId, candidate);
    };

    if (observation.conceptId) {
      if (!this.index.get(observation.conceptId)) throw new Error("Unknown private concept identity");
      add({ conceptId: observation.conceptId, confidence: 1, source: "exact" });
    }

    if (observation.language && observation.lexeme) {
      if (!this.index.resolveAlias) throw new Error("Private import adapter required");
      for (const conceptId of this.index.resolveAlias(observation.language, observation.lexeme)) {
        add({ conceptId, confidence: 0.99, source: "private-alias" });
      }
    }

    if (observation.vector) {
      for (const match of this.index.nearest(observation.vector, limit * 2)) {
        const confidence = Math.max(0, Math.min(1, (match.score + 1) / 2));
        add({ conceptId: match.conceptId, confidence, source: "embedding" });
      }
    }

    return [...merged.values()]
      .sort((a, b) => b.confidence - a.confidence || a.conceptId.localeCompare(b.conceptId))
      .slice(0, limit);
  }

  observe(conceptId: string, weight = 1): void {
    this.requireConcept(conceptId);
    if (!Number.isFinite(weight) || weight <= 0) throw new Error("weight must be > 0");
    this.exposures.set(conceptId, (this.exposures.get(conceptId) ?? 0) + weight);
  }

  associate(fromConceptId: string, toConceptId: string, weight = 1): void {
    this.requireConcept(fromConceptId);
    this.requireConcept(toConceptId);
    if (!Number.isFinite(weight) || weight <= 0) throw new Error("weight must be > 0");
    const key = associationKey(fromConceptId, toConceptId);
    this.associations.set(key, (this.associations.get(key) ?? 0) + weight);
  }

  related(conceptId: string, limit = 8): ConceptCandidate[] {
    this.requireConcept(conceptId);
    const candidates: ConceptCandidate[] = [];
    let max = 0;

    for (const [key, weight] of this.associations) {
      const [from, to] = splitAssociationKey(key);
      if (from !== conceptId) continue;
      max = Math.max(max, weight);
      candidates.push({ conceptId: to, confidence: weight, source: "association" });
    }

    if (max > 0) {
      for (const candidate of candidates) candidate.confidence = candidate.confidence / max;
    }

    return candidates
      .sort((a, b) => b.confidence - a.confidence || a.conceptId.localeCompare(b.conceptId))
      .slice(0, limit);
  }

  snapshot(): LearnerSnapshot {
    const exposures = [...this.exposures.entries()].sort(([a], [b]) => a.localeCompare(b));
    const associations = [...this.associations.entries()]
      .map(([key, weight]) => {
        const [from, to] = splitAssociationKey(key);
        return [from, to, weight] as [string, string, number];
      })
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

    return {
      format: "vaml-agent-learning-state",
      version: "0.2",
      exposures,
      associations,
    };
  }

  restore(snapshot: LearnerSnapshot): void {
    if (snapshot.format !== "vaml-agent-learning-state" || snapshot.version !== "0.2") {
      throw new Error("Unsupported VAML learner snapshot");
    }
    this.exposures.clear();
    this.associations.clear();

    for (const [conceptId, weight] of snapshot.exposures) {
      this.requireConcept(conceptId);
      if (!Number.isFinite(weight) || weight < 0) throw new Error("Invalid exposure weight");
      this.exposures.set(conceptId, weight);
    }
    for (const [from, to, weight] of snapshot.associations) {
      this.requireConcept(from);
      this.requireConcept(to);
      if (!Number.isFinite(weight) || weight < 0) throw new Error("Invalid association weight");
      this.associations.set(associationKey(from, to), weight);
    }
  }

  fingerprint(): string {
    return canonicalJson(this.snapshot());
  }

  private requireConcept(conceptId: string): void {
    if (!this.index.get(conceptId)) throw new Error(`Unknown private concept: ${conceptId}`);
  }
}

function associationKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function splitAssociationKey(value: string): [string, string] {
  const position = value.indexOf("\u0000");
  if (position < 0) throw new Error("Invalid association key");
  return [value.slice(0, position), value.slice(position + 1)];
}
