import { randomBytes, type KeyObject } from "node:crypto";
import {
  assertId,
  assertKey,
  b64,
  canonicalJson,
  deriveKey,
  equalSecret,
  exportPublicKey,
  generateEphemeralX25519,
  hmacSha256,
  sha256,
  sharedSecret,
  unb64,
} from "./crypto.js";
import type {
  HandshakeHello,
  SessionContext,
  VocabularyManifest,
} from "./types.js";
export const MAX_ACTIVE = 4096;
const FEATURES = [
  "opaque-codebook",
  "x25519",
  "hkdf-sha256",
  "aes-256-gcm",
  "replay-sequence",
  "active-set",
  "psk-confirmation",
];
export interface ConceptResolver {
  has(id: string): boolean;
}
export interface PendingHandshake {
  hello: HandshakeHello;
  privateKey: KeyObject;
  consumed?: boolean;
}
export interface NegotiatedSession {
  context: SessionContext;
  conceptToCode: Map<string, bigint>;
  codeToConcept: Map<bigint, string>;
  confirmationTag: string;
  expectedConfirmation: Buffer;
  activate(ids: string[]): void;
}
export function defaultManifest(packIds: string[]): VocabularyManifest {
  return {
    protocol: "VAML",
    version: "0.2",
    packIds: [...new Set(packIds)].sort(),
    features: [...FEATURES],
    maxFrameBytes: 1048576,
    valueTypes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  };
}
function validateHello(h: HandshakeHello): void {
  if (
    !h ||
    h.protocol !== "VAML" ||
    h.version !== "0.2" ||
    h.manifest?.protocol !== "VAML" ||
    h.manifest.version !== "0.2"
  )
    throw new Error("VAML version mismatch");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(h.agentId))
    throw new Error("Invalid peer identity");
  if (unb64(h.nonce).length !== 32 || unb64(h.ephemeralPublicKey).length !== 44)
    throw new Error("Invalid handshake material");
  const m = h.manifest;
  if (
    !Array.isArray(m.packIds) ||
    m.packIds.length < 1 ||
    m.packIds.length > 32 ||
    new Set(m.packIds).size !== m.packIds.length
  )
    throw new Error("Invalid pack manifest");
  m.packIds.forEach(assertId);
  if (
    !Array.isArray(m.features) ||
    m.features.length !== FEATURES.length ||
    FEATURES.some((f) => !m.features.includes(f))
  )
    throw new Error("Handshake downgrade rejected");
  if (
    !Number.isInteger(m.maxFrameBytes) ||
    m.maxFrameBytes < 256 ||
    m.maxFrameBytes > 1048576
  )
    throw new Error("Invalid frame limit");
  if (
    !Array.isArray(m.valueTypes) ||
    !m.valueTypes.length ||
    m.valueTypes.some((t) => !Number.isInteger(t) || t < 0 || t > 9) ||
    new Set(m.valueTypes).size !== m.valueTypes.length
  )
    throw new Error("Invalid value types");
}
export function beginHandshake(
  agentId: string,
  manifest: VocabularyManifest,
): PendingHandshake {
  const pair = generateEphemeralX25519();
  const hello: HandshakeHello = {
    protocol: "VAML",
    version: "0.2",
    agentId,
    ephemeralPublicKey: exportPublicKey(pair.publicKey),
    nonce: b64(randomBytes(32)),
    manifest: structuredClone(manifest),
  };
  validateHello(hello);
  return { privateKey: pair.privateKey, hello };
}
/** The resolver is restricted to the pinned shared catalog. No vocabulary enumeration. */
export function finishHandshake(
  pending: PendingHandshake,
  remote: HandshakeHello,
  resolver: ConceptResolver,
  authKey: Uint8Array,
  expectedPeer: string,
): NegotiatedSession {
  if (pending.consumed) throw new Error("Handshake already consumed");
  pending.consumed = true;
  assertKey(authKey);
  validateHello(pending.hello);
  validateHello(remote);
  const local = pending.hello;
  if (
    remote.agentId !== expectedPeer ||
    local.agentId === remote.agentId ||
    local.ephemeralPublicKey === remote.ephemeralPublicKey
  )
    throw new Error("Peer/reflection mismatch");
  if (
    canonicalJson([...local.manifest.packIds].sort()) !==
    canonicalJson([...remote.manifest.packIds].sort())
  )
    throw new Error("No shared private vocabulary pack");
  const ordered = [local, remote].sort((a, b) =>
    a.agentId < b.agentId ? -1 : 1,
  );
  const transcript = Buffer.from(canonicalJson(ordered)),
    salt = sha256(transcript);
  const secret = sharedSecret(pending.privateKey, remote.ephemeralPublicKey);
  const ikm = hmacSha256(authKey, secret);
  secret.fill(0);
  const low = local.agentId === ordered[0].agentId;
  const keys = {
    sendKey: deriveKey(
      ikm,
      salt,
      low ? "VAML-0.2/low-high" : "VAML-0.2/high-low",
    ),
    receiveKey: deriveKey(
      ikm,
      salt,
      low ? "VAML-0.2/high-low" : "VAML-0.2/low-high",
    ),
    codebookKey: deriveKey(ikm, salt, "VAML-0.2/codebook"),
    confirmKey: deriveKey(ikm, salt, "VAML-0.2/confirmation"),
  };
  ikm.fill(0);
  const conceptToCode = new Map<string, bigint>(),
    codeToConcept = new Map<bigint, string>();
  const context: SessionContext = {
    sessionId: salt.readBigUInt64BE(),
    localAgentId: local.agentId,
    remoteAgentId: remote.agentId,
    keys,
    sendSequence: 0n,
    receiveSequence: 0n,
    confirmed: false,
    maxFrameBytes: Math.min(
      local.manifest.maxFrameBytes,
      remote.manifest.maxFrameBytes,
    ),
    valueTypes: local.manifest.valueTypes.filter((t) =>
      remote.manifest.valueTypes.includes(t),
    ),
  };
  return {
    context,
    conceptToCode,
    codeToConcept,
    confirmationTag: b64(
      hmacSha256(
        keys.confirmKey,
        Buffer.concat([transcript, Buffer.from(local.agentId)]),
      ),
    ),
    expectedConfirmation: hmacSha256(
      keys.confirmKey,
      Buffer.concat([transcript, Buffer.from(remote.agentId)]),
    ),
    activate(ids) {
      if (!context.confirmed) throw new Error("Handshake not confirmed");
      if (
        ids.length > MAX_ACTIVE ||
        new Set([...conceptToCode.keys(), ...ids]).size > MAX_ACTIVE
      )
        throw new Error("Active set limit");
      const additions = new Map<bigint, string>();
      for (const id of ids) {
        assertId(id);
        if (!resolver.has(id))
          throw new Error("Unknown or unauthorized concept");
        const code = hmacSha256(keys.codebookKey, unb64(id)).readBigUInt64BE();
        const existing = additions.get(code) ?? codeToConcept.get(code);
        if (existing && existing !== id)
          throw new Error("Session code collision; renegotiate");
        additions.set(code, id);
      }
      for (const [code, id] of additions) {
        conceptToCode.set(id, code);
        codeToConcept.set(code, id);
      }
    },
  };
}
export function verifyConfirmation(
  local: NegotiatedSession,
  remoteTag: string,
): void {
  if (!equalSecret(local.expectedConfirmation, unb64(remoteTag)))
    throw new Error("Handshake confirmation mismatch");
  local.context.confirmed = true;
}
