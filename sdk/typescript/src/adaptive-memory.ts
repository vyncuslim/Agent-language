import { randomBytes } from "node:crypto";
import { assertKey, b64, canonicalJson, hmacSha256 } from "./crypto.js";
import type { CompiledConceptRecord } from "./types.js";
import type { SemanticResolver } from "./learning.js";

export interface AdaptiveLearningPolicy {
  similarityThreshold: number;
  promotionExposure: number;
  promotionConfidence: number;
  maxLearnedConcepts: number;
  maxVectorDimensions: number;
  learningRate: number;
  negativePenalty: number;
}

export interface LearningExperience {
  conceptId?: string;
  vector?: number[];
  relatedConceptIds?: string[];
  weight?: number;
  outcome?: "positive" | "neutral" | "negative";
  domain?: string;
  evidenceDigest?: string;
}

export interface LearnedConceptState {
  conceptId: string;
  prototype?: number[];
  exposure: number;
  confidence: number;
  promoted: boolean;
  createdAt: string;
  updatedAt: string;
  relatedConceptIds: string[];
  domain?: string;
  evidenceDigests: string[];
}

export interface AdaptiveMemorySnapshot {
  format: "vaml-adaptive-semantic-memory";
  version: "0.1";
  concepts: LearnedConceptState[];
}

export interface LearningResult {
  conceptId: string;
  created: boolean;
  promoted: boolean;
  confidence: number;
  exposure: number;
  nearestScore?: number;
}

const DEFAULT_POLICY: AdaptiveLearningPolicy = {
  similarityThreshold: 0.92,
  promotionExposure: 3,
  promotionConfidence: 0.72,
  maxLearnedConcepts: 10000,
  maxVectorDimensions: 4096,
  learningRate: 0.2,
  negativePenalty: 0.25,
};

/**
 * Mutable, runtime-local semantic overlay for agent-native learning.
 *
 * It never changes protocol code, keys, authorization policy or the immutable
 * base vocabulary. New concepts stay private to this overlay until promotion
 * thresholds are met. Human labels are intentionally not stored here.
 */
export class AdaptiveSemanticMemory implements SemanticResolver {
  private readonly learned = new Map<string, LearnedConceptState>();
  private readonly learningKey: Buffer;
  readonly policy: AdaptiveLearningPolicy;

  constructor(
    readonly base: SemanticResolver,
    learningKey: Uint8Array,
    policy: Partial<AdaptiveLearningPolicy> = {},
  ) {
    assertKey(learningKey);
    this.learningKey = Buffer.from(learningKey);
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.validatePolicy();
  }

  /** Internal learning lookup. Includes candidates that are not promoted yet. */
  get(conceptId: string): CompiledConceptRecord | undefined {
    const existing = this.base.get(conceptId);
    if (existing) return existing;
    const state = this.learned.get(conceptId);
    return state ? this.recordFor(state) : undefined;
  }

  /** Network authorization surface: unpromoted learned concepts stay local. */
  has(conceptId: string): boolean {
    if (this.base.get(conceptId)) return true;
    return this.learned.get(conceptId)?.promoted === true;
  }

  /** Semantic surface compatible with NetworkConfig. */
  semantic(conceptId: string): unknown {
    const base = this.base.get(conceptId);
    if (base) return base.semantic;
    const state = this.learned.get(conceptId);
    if (!state || !state.promoted) throw new Error("Unknown or unpromoted private concept");
    return this.recordFor(state).semantic;
  }

  resolveAlias(language: string, lexeme: string): string[] {
    return this.base.resolveAlias?.(language, lexeme) ?? [];
  }

  nearest(vector: number[], limit = 8): Array<{ conceptId: string; score: number }> {
    this.validateVector(vector);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid nearest limit");
    const merged = new Map<string, number>();
    for (const candidate of this.base.nearest(vector, Math.min(100, limit * 2))) {
      merged.set(candidate.conceptId, candidate.score);
    }
    for (const state of this.learned.values()) {
      if (!state.prototype || state.prototype.length !== vector.length) continue;
      const score = cosine(vector, state.prototype);
      const previous = merged.get(state.conceptId);
      if (previous === undefined || score > previous) merged.set(state.conceptId, score);
    }
    return [...merged.entries()]
      .map(([conceptId, score]) => ({ conceptId, score }))
      .sort((a, b) => b.score - a.score || a.conceptId.localeCompare(b.conceptId))
      .slice(0, limit);
  }

  learn(experience: LearningExperience): LearningResult {
    const weight = experience.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1000) throw new Error("Invalid learning weight");
    if (experience.vector) this.validateVector(experience.vector);
    if (!experience.conceptId && !experience.vector) throw new Error("Learning requires conceptId or vector");

    if (experience.conceptId) {
      const known = this.get(experience.conceptId);
      if (!known) throw new Error("Cannot reinforce unknown explicit concept");
      const state = this.learned.get(experience.conceptId);
      if (!state) {
        return {
          conceptId: experience.conceptId,
          created: false,
          promoted: true,
          confidence: 1,
          exposure: weight,
        };
      }
      this.updateState(state, experience, weight);
      return this.result(state, false);
    }

    const nearest = this.nearest(experience.vector!, 1)[0];
    if (nearest && nearest.score >= this.policy.similarityThreshold) {
      const state = this.learned.get(nearest.conceptId);
      if (state) {
        this.updateState(state, experience, weight);
        return this.result(state, false, nearest.score);
      }
      return {
        conceptId: nearest.conceptId,
        created: false,
        promoted: true,
        confidence: Math.max(0, Math.min(1, (nearest.score + 1) / 2)),
        exposure: weight,
        nearestScore: nearest.score,
      };
    }

    if (this.learned.size >= this.policy.maxLearnedConcepts) throw new Error("Learned concept limit reached");
    const now = new Date().toISOString();
    const conceptId = this.newConceptId(experience);
    const state: LearnedConceptState = {
      conceptId,
      prototype: experience.vector ? [...experience.vector] : undefined,
      exposure: weight,
      confidence: initialConfidence(experience.outcome),
      promoted: false,
      createdAt: now,
      updatedAt: now,
      relatedConceptIds: this.validateRelated(experience.relatedConceptIds),
      domain: normalizeOptional(experience.domain),
      evidenceDigests: normalizeEvidence(experience.evidenceDigest),
    };
    this.applyPromotion(state);
    this.learned.set(conceptId, state);
    return this.result(state, true, nearest?.score);
  }

  state(conceptId: string): LearnedConceptState | undefined {
    const value = this.learned.get(conceptId);
    return value ? structuredClone(value) : undefined;
  }

  promoted(limit = 100): LearnedConceptState[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.policy.maxLearnedConcepts) throw new Error("Invalid promoted limit");
    return [...this.learned.values()]
      .filter((state) => state.promoted)
      .sort((a, b) => b.confidence - a.confidence || b.exposure - a.exposure || a.conceptId.localeCompare(b.conceptId))
      .slice(0, limit)
      .map((state) => structuredClone(state));
  }

  snapshot(): AdaptiveMemorySnapshot {
    return {
      format: "vaml-adaptive-semantic-memory",
      version: "0.1",
      concepts: [...this.learned.values()]
        .sort((a, b) => a.conceptId.localeCompare(b.conceptId))
        .map((state) => structuredClone(state)),
    };
  }

  restore(snapshot: AdaptiveMemorySnapshot): void {
    if (snapshot?.format !== "vaml-adaptive-semantic-memory" || snapshot.version !== "0.1" || !Array.isArray(snapshot.concepts)) {
      throw new Error("Unsupported adaptive memory snapshot");
    }
    if (snapshot.concepts.length > this.policy.maxLearnedConcepts) throw new Error("Learned concept limit reached");

    const replacement = new Map<string, LearnedConceptState>();
    for (const raw of snapshot.concepts) {
      const state = structuredClone(raw);
      if (!/^[A-Za-z0-9_-]{43}$/.test(state.conceptId)) throw new Error("Invalid learned concept identity");
      if (this.base.get(state.conceptId) || replacement.has(state.conceptId)) throw new Error("Duplicate learned concept identity");
      if (state.prototype) this.validateVector(state.prototype);
      if (!Number.isFinite(state.exposure) || state.exposure <= 0) throw new Error("Invalid learned exposure");
      if (!Number.isFinite(state.confidence) || state.confidence < 0 || state.confidence > 1) throw new Error("Invalid learned confidence");
      if (typeof state.promoted !== "boolean") throw new Error("Invalid learned promotion state");
      state.evidenceDigests = [...new Set(state.evidenceDigests ?? [])].sort();
      replacement.set(state.conceptId, state);
    }

    const stagedIds = new Set(replacement.keys());
    for (const state of replacement.values()) {
      state.relatedConceptIds = this.validateRelated(state.relatedConceptIds, stagedIds);
    }

    this.learned.clear();
    for (const [id, state] of replacement) this.learned.set(id, state);
  }

  fingerprint(): string {
    return canonicalJson(this.snapshot());
  }

  close(): void {
    this.learningKey.fill(0);
    this.learned.clear();
  }

  private recordFor(state: LearnedConceptState): CompiledConceptRecord {
    return {
      conceptId: state.conceptId,
      semantic: {
        kind: "agent-native",
        prototype: state.prototype,
        relatedConceptIds: state.relatedConceptIds,
        confidence: state.confidence,
      },
      domains: state.domain ? [state.domain] : [],
      embedding: state.prototype ? [...state.prototype] : undefined,
      metadata: {
        learned: true,
        promoted: state.promoted,
        exposure: state.exposure,
        evidenceDigests: [...state.evidenceDigests],
      },
    };
  }

  private updateState(state: LearnedConceptState, experience: LearningExperience, weight: number): void {
    const previousExposure = state.exposure;
    state.exposure += weight;
    if (experience.vector) {
      if (!state.prototype) state.prototype = [...experience.vector];
      else if (state.prototype.length === experience.vector.length) {
        const alpha = Math.min(1, this.policy.learningRate * weight / Math.max(1, previousExposure + weight));
        for (let i = 0; i < state.prototype.length; i++) {
          state.prototype[i] = state.prototype[i] * (1 - alpha) + experience.vector[i] * alpha;
        }
      } else throw new Error("Prototype dimension mismatch");
    }
    if (experience.outcome === "positive") {
      state.confidence += (1 - state.confidence) * this.policy.learningRate * Math.min(1, weight);
    }
    if (experience.outcome === "negative") {
      state.confidence -= state.confidence * this.policy.negativePenalty * Math.min(1, weight);
    }
    state.confidence = Math.max(0, Math.min(1, state.confidence));
    state.relatedConceptIds = [...new Set([
      ...state.relatedConceptIds,
      ...this.validateRelated(experience.relatedConceptIds),
    ])].sort();
    const evidence = normalizeEvidence(experience.evidenceDigest);
    state.evidenceDigests = [...new Set([...state.evidenceDigests, ...evidence])].sort();
    state.domain = normalizeOptional(experience.domain) ?? state.domain;
    state.updatedAt = new Date().toISOString();
    this.applyPromotion(state);
  }

  private applyPromotion(state: LearnedConceptState): void {
    state.promoted = state.exposure >= this.policy.promotionExposure && state.confidence >= this.policy.promotionConfidence;
  }

  private result(state: LearnedConceptState, created: boolean, nearestScore?: number): LearningResult {
    return {
      conceptId: state.conceptId,
      created,
      promoted: state.promoted,
      confidence: state.confidence,
      exposure: state.exposure,
      nearestScore,
    };
  }

  private newConceptId(experience: LearningExperience): string {
    const material = Buffer.concat([
      randomBytes(32),
      Buffer.from(canonicalJson({
        vector: experience.vector ?? null,
        domain: normalizeOptional(experience.domain) ?? null,
        relatedConceptIds: [...(experience.relatedConceptIds ?? [])].sort(),
      })),
    ]);
    return b64(hmacSha256(this.learningKey, material));
  }

  private validateVector(vector: number[]): void {
    if (!Array.isArray(vector) || vector.length < 1 || vector.length > this.policy.maxVectorDimensions || vector.some((value) => !Number.isFinite(value))) {
      throw new Error("Invalid learning vector");
    }
  }

  private validateRelated(ids: string[] | undefined, stagedIds?: Set<string>): string[] {
    const output = [...new Set(ids ?? [])].sort();
    if (output.length > 256) throw new Error("Too many related concepts");
    for (const id of output) {
      const learnedKnown = stagedIds ? stagedIds.has(id) : this.learned.has(id);
      if (!this.base.get(id) && !learnedKnown) throw new Error("Unknown related concept");
    }
    return output;
  }

  private validatePolicy(): void {
    const p = this.policy;
    if (!(p.similarityThreshold >= -1 && p.similarityThreshold <= 1)) throw new Error("Invalid similarity threshold");
    if (!Number.isFinite(p.promotionExposure) || p.promotionExposure <= 0) throw new Error("Invalid promotion exposure");
    if (!(p.promotionConfidence >= 0 && p.promotionConfidence <= 1)) throw new Error("Invalid promotion confidence");
    if (!Number.isInteger(p.maxLearnedConcepts) || p.maxLearnedConcepts < 1 || p.maxLearnedConcepts > 1_000_000) throw new Error("Invalid learned concept limit");
    if (!Number.isInteger(p.maxVectorDimensions) || p.maxVectorDimensions < 1 || p.maxVectorDimensions > 65536) throw new Error("Invalid vector dimension limit");
    if (!(p.learningRate > 0 && p.learningRate <= 1)) throw new Error("Invalid learning rate");
    if (!(p.negativePenalty > 0 && p.negativePenalty <= 1)) throw new Error("Invalid negative penalty");
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function initialConfidence(outcome: LearningExperience["outcome"]): number {
  if (outcome === "positive") return 0.7;
  if (outcome === "negative") return 0.2;
  return 0.5;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.normalize("NFKC").trim();
  return normalized || undefined;
}

function normalizeEvidence(value: string | undefined): string[] {
  const normalized = normalizeOptional(value);
  if (!normalized) return [];
  if (normalized.length > 256) throw new Error("Evidence digest too long");
  return [normalized];
}
