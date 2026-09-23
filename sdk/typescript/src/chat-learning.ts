import { ValueType, type SemanticField } from "./types.js";
import type { VamlAgentBrain, AgentBrainContext } from "./agent-bridge.js";
import type { AdaptiveSemanticMemory, LearningExperience } from "./adaptive-memory.js";

export type VamlChatRole = "system" | "user" | "assistant" | "agent";

export interface VamlChatTurn {
  role: VamlChatRole;
  content: string;
  createdAtMs: number;
}

export interface VamlChatSemanticPayload {
  text: string;
  fields: SemanticField[];
  /** Optional model-native vector used only by the local learning layer. */
  vector?: number[];
  /** Optional existing concept identities reinforced by this turn. */
  conceptIds?: string[];
  /** Optional evidence digest for provenance-aware learning. */
  evidenceDigest?: string;
}

export interface VamlChatCodecContext {
  direction: "encode" | "decode";
  history: readonly VamlChatTurn[];
  agentId?: string;
  peerId?: string;
}

/**
 * Local bridge between human/model text and VAML semantic fields.
 *
 * Implementations stay private to the application. Human aliases and prompts
 * are never required by the VAML wire protocol. The network layer still sees
 * only authenticated encrypted VAML frames.
 */
export interface VamlChatCodec {
  encode(text: string, context: VamlChatCodecContext): Promise<VamlChatSemanticPayload> | VamlChatSemanticPayload;
  decode(fields: readonly SemanticField[], context: VamlChatCodecContext): Promise<VamlChatSemanticPayload> | VamlChatSemanticPayload;
}

export interface VamlChatModelContext {
  message: string;
  history: readonly VamlChatTurn[];
  agent?: AgentBrainContext;
  /** Promoted private concepts that the learning layer considers reusable. */
  learnedConceptIds: string[];
}

/** Model-neutral text response surface: LLM, local model, planner or rules engine. */
export type VamlChatModel = (context: VamlChatModelContext) => Promise<string> | string;

export interface LearningChatAgentOptions {
  model: VamlChatModel;
  codec: VamlChatCodec;
  memory?: AdaptiveSemanticMemory;
  maxHistory?: number;
  learningDomain?: string;
  /** Optional extra experiences extracted by an application-specific learner. */
  extractLearning?: (payload: VamlChatSemanticPayload, role: VamlChatRole) => LearningExperience[];
}

export interface LearningChatSnapshot {
  format: "vaml-learning-chat";
  version: "0.1";
  history: VamlChatTurn[];
  memory?: ReturnType<AdaptiveSemanticMemory["snapshot"]>;
}

/**
 * High-level chat wrapper for VAML Agents.
 *
 * It performs three jobs without changing the VAML protocol:
 * 1. local text <-> semantic field conversion through a private codec;
 * 2. model-neutral multi-turn chat;
 * 3. adaptive semantic learning from every accepted incoming/outgoing turn.
 */
export class LearningChatAgent {
  private readonly turns: VamlChatTurn[] = [];
  private readonly maxHistory: number;
  private readonly learningDomain?: string;

  constructor(readonly options: LearningChatAgentOptions) {
    this.maxHistory = options.maxHistory ?? 128;
    if (!Number.isInteger(this.maxHistory) || this.maxHistory < 1 || this.maxHistory > 4096) {
      throw new Error("Invalid chat history limit");
    }
    this.learningDomain = normalizeOptional(options.learningDomain);
  }

  history(): VamlChatTurn[] {
    return structuredClone(this.turns);
  }

  /** Local human/model chat using exactly the same learning path as network turns. */
  async chat(text: string): Promise<string> {
    const message = normalizeText(text);
    const encoded = await this.options.codec.encode(message, {
      direction: "encode",
      history: this.history(),
    });
    this.validatePayload(encoded, message);
    this.learn(encoded, "user");
    this.push("user", message);

    const response = normalizeText(await this.options.model({
      message,
      history: this.history(),
      learnedConceptIds: this.promotedConceptIds(),
    }));
    const outbound = await this.options.codec.encode(response, {
      direction: "encode",
      history: this.history(),
    });
    this.validatePayload(outbound, response);
    this.learn(outbound, "assistant");
    this.push("assistant", response);
    return response;
  }

  /**
   * VamlAgentBrain adapter for startAgentServer/runAgentDialogue.
   * Incoming authenticated semantic fields are decoded locally, learned,
   * passed to the model, encoded back to fields, learned again and returned.
   */
  brain(): VamlAgentBrain {
    return async (agent) => {
      const inbound = await this.options.codec.decode(agent.message.fields, {
        direction: "decode",
        history: this.history(),
        agentId: agent.agentId,
        peerId: agent.peerId,
      });
      this.validatePayload(inbound);
      this.learn(inbound, "agent");
      this.push("agent", inbound.text);

      const response = normalizeText(await this.options.model({
        message: inbound.text,
        history: this.history(),
        agent,
        learnedConceptIds: this.promotedConceptIds(),
      }));
      const outbound = await this.options.codec.encode(response, {
        direction: "encode",
        history: this.history(),
        agentId: agent.agentId,
        peerId: agent.peerId,
      });
      this.validatePayload(outbound, response);
      this.learn(outbound, "assistant");
      this.push("assistant", response);
      return structuredClone(outbound.fields);
    };
  }

  snapshot(): LearningChatSnapshot {
    return {
      format: "vaml-learning-chat",
      version: "0.1",
      history: this.history(),
      ...(this.options.memory ? { memory: this.options.memory.snapshot() } : {}),
    };
  }

  restore(snapshot: LearningChatSnapshot): void {
    if (snapshot?.format !== "vaml-learning-chat" || snapshot.version !== "0.1" || !Array.isArray(snapshot.history)) {
      throw new Error("Unsupported learning chat snapshot");
    }
    this.turns.length = 0;
    for (const turn of snapshot.history.slice(-this.maxHistory)) {
      if (!turn || !["system", "user", "assistant", "agent"].includes(turn.role)) throw new Error("Invalid chat role");
      const content = normalizeText(turn.content);
      if (!Number.isSafeInteger(turn.createdAtMs) || turn.createdAtMs < 0) throw new Error("Invalid chat timestamp");
      this.turns.push({ role: turn.role, content, createdAtMs: turn.createdAtMs });
    }
    if (snapshot.memory) {
      if (!this.options.memory) throw new Error("Snapshot contains adaptive memory but this agent has no memory");
      this.options.memory.restore(snapshot.memory);
    }
  }

  private learn(payload: VamlChatSemanticPayload, role: VamlChatRole): void {
    const memory = this.options.memory;
    if (!memory) return;

    if (payload.vector) {
      memory.learn({
        vector: payload.vector,
        outcome: "positive",
        domain: this.learningDomain,
        evidenceDigest: payload.evidenceDigest,
      });
    }
    for (const conceptId of new Set(payload.conceptIds ?? [])) {
      if (memory.get(conceptId)) {
        memory.learn({
          conceptId,
          outcome: "positive",
          domain: this.learningDomain,
          evidenceDigest: payload.evidenceDigest,
        });
      }
    }
    for (const experience of this.options.extractLearning?.(payload, role) ?? []) {
      memory.learn(experience);
    }
  }

  private promotedConceptIds(): string[] {
    return this.options.memory?.promoted(64).map((state) => state.conceptId) ?? [];
  }

  private push(role: VamlChatRole, content: string): void {
    this.turns.push({ role, content, createdAtMs: Date.now() });
    if (this.turns.length > this.maxHistory) this.turns.splice(0, this.turns.length - this.maxHistory);
  }

  private validatePayload(payload: VamlChatSemanticPayload, expectedText?: string): void {
    if (!payload || typeof payload !== "object") throw new Error("Chat codec returned invalid payload");
    const text = normalizeText(payload.text);
    if (expectedText !== undefined && text !== expectedText) throw new Error("Chat codec changed local text identity");
    if (!Array.isArray(payload.fields) || payload.fields.length < 1) throw new Error("Chat codec returned no semantic fields");
    if (payload.vector) validateVector(payload.vector);
    if (payload.conceptIds && !payload.conceptIds.every((id) => typeof id === "string" && id.length > 0)) {
      throw new Error("Invalid learned concept identity");
    }
  }
}

/**
 * Minimal ready-to-use encrypted chat codec.
 *
 * The caller supplies a private concept identity representing an utterance.
 * Text is carried as ValueType.Utf8 inside the normal VAML authenticated
 * encryption envelope; it is never emitted as a public protocol label.
 * Applications that want richer machine semantics can replace this codec
 * with a concept/vector codec without changing LearningChatAgent.
 */
export class EncryptedUtf8ChatCodec implements VamlChatCodec {
  constructor(
    readonly utteranceConceptId: string,
    readonly embed?: (text: string) => Promise<number[]> | number[],
  ) {
    if (!utteranceConceptId) throw new Error("utteranceConceptId is required");
  }

  async encode(text: string): Promise<VamlChatSemanticPayload> {
    const normalized = normalizeText(text);
    const vector = this.embed ? await this.embed(normalized) : undefined;
    if (vector) validateVector(vector);
    return {
      text: normalized,
      fields: [{ conceptId: this.utteranceConceptId, valueType: ValueType.Utf8, value: normalized }],
      ...(vector ? { vector } : {}),
      conceptIds: [this.utteranceConceptId],
    };
  }

  async decode(fields: readonly SemanticField[]): Promise<VamlChatSemanticPayload> {
    if (!Array.isArray(fields) || fields.length !== 1) throw new Error("EncryptedUtf8ChatCodec expects exactly one field");
    const field = fields[0];
    if (field.conceptId !== this.utteranceConceptId || field.valueType !== ValueType.Utf8 || typeof field.value !== "string") {
      throw new Error("Unexpected chat semantic field");
    }
    return this.encode(field.value);
  }
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Chat text must be a string");
  const text = value.normalize("NFC");
  if (!text.trim()) throw new Error("Chat text cannot be empty");
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("Chat text too large");
  return text;
}

function validateVector(vector: number[]): void {
  if (!Array.isArray(vector) || vector.length < 1 || vector.length > 4096 || vector.some((n) => !Number.isFinite(n))) {
    throw new Error("Invalid chat learning vector");
  }
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}
