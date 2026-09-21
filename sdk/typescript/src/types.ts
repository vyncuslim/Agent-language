export enum ValueType {
  None = 0x00,
  U64 = 0x01,
  I64 = 0x02,
  F64 = 0x03,
  Bool = 0x04,
  Bytes = 0x05,
  Utf8 = 0x06,
  Concept = 0x07,
  Ref = 0x08,
  Json = 0x09,
}

export interface ConceptSourceRecord {
  /** Private canonical semantic descriptor. Never required on the wire. */
  semantic: unknown;
  /** Optional human-language aliases used only by import/export adapters. */
  aliases?: Record<string, string[]>;
  relations?: Record<string, string[]>;
  domains?: string[];
  metadata?: Record<string, unknown>;
}

export interface CompiledConceptRecord {
  conceptId: string;
  domains: string[];
  relations?: Record<string, string[]>;
  metadata?: Record<string, unknown>;
}

export interface PrivateLexiconPayload {
  format: "vaml-private-lexicon";
  version: "0.2";
  createdAt: string;
  concepts: CompiledConceptRecord[];
}

export interface EncryptedLexiconPack {
  format: "vaml-encrypted-vocab";
  version: "0.2";
  algorithm: "AES-256-GCM";
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  packId: string;
}

export interface VocabularyManifest {
  protocol: "VAML";
  version: "0.2";
  packIds: string[];
  features: string[];
  maxFrameBytes: number;
  valueTypes: number[];
}

export interface HandshakeHello {
  protocol: "VAML";
  version: "0.2";
  agentId: string;
  ephemeralPublicKey: string;
  nonce: string;
  manifest: VocabularyManifest;
}

export interface SessionKeys {
  frameKey: Buffer;
  codebookKey: Buffer;
  confirmKey: Buffer;
}

export interface SessionContext {
  sessionId: bigint;
  localAgentId: string;
  remoteAgentId: string;
  keys: SessionKeys;
  sendSequence: bigint;
  receiveSequence: bigint;
}

export interface SemanticField {
  conceptId: string;
  valueType: ValueType;
  value?: unknown;
}

export interface WireField {
  sessionCode: bigint;
  valueType: ValueType;
  value?: unknown;
}

export interface CompileInput {
  peer: string;
  fields: SemanticField[];
}
