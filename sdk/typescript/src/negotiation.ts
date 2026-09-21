import { createHmac, randomBytes, type KeyObject } from "node:crypto";
import {
  b64,
  canonicalJson,
  deriveKey,
  exportPublicKey,
  generateEphemeralX25519,
  hmacSha256,
  sha256,
  sharedSecret,
} from "./crypto.js";
import type {
  HandshakeHello,
  PrivateLexiconPayload,
  SessionContext,
  SessionKeys,
  VocabularyManifest,
} from "./types.js";

export interface PendingHandshake {
  hello: HandshakeHello;
  privateKey: KeyObject;
}

export interface NegotiatedSession {
  context: SessionContext;
  conceptToCode: Map<string, bigint>;
  codeToConcept: Map<bigint, string>;
  confirmationTag: string;
}

export function defaultManifest(packIds: string[]): VocabularyManifest {
  return {
    protocol: "VAML",
    version: "0.2",
    packIds: [...packIds].sort(),
    features: ["opaque-codebook", "x25519", "hkdf-sha256", "aes-256-gcm", "replay-sequence"],
    maxFrameBytes: 8 * 1024 * 1024,
    valueTypes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  };
}

export function beginHandshake(agentId: string, manifest: VocabularyManifest): PendingHandshake {
  const pair = generateEphemeralX25519();
  return {
    privateKey: pair.privateKey,
    hello: {
      protocol: "VAML",
      version: "0.2",
      agentId,
      ephemeralPublicKey: exportPublicKey(pair.publicKey),
      nonce: b64(randomBytes(32)),
      manifest,
    },
  };
}

function canonicalTranscript(a: HandshakeHello, b: HandshakeHello): Buffer {
  const ordered = [a, b].sort((x, y) => {
    const byKey = x.ephemeralPublicKey.localeCompare(y.ephemeralPublicKey);
    return byKey || x.agentId.localeCompare(y.agentId);
  });
  return Buffer.from(canonicalJson(ordered), "utf8");
}

function assertCompatible(local: HandshakeHello, remote: HandshakeHello): string[] {
  if (local.protocol !== "VAML" || remote.protocol !== "VAML") throw new Error("Protocol mismatch");
  if (local.version !== "0.2" || remote.version !== "0.2") throw new Error("VAML version mismatch");

  const sharedPacks = local.manifest.packIds.filter((id) => remote.manifest.packIds.includes(id)).sort();
  if (sharedPacks.length === 0) throw new Error("No shared private vocabulary pack");
  return sharedPacks;
}

function deriveSessionKeys(secret: Buffer, transcript: Buffer): SessionKeys {
  const salt = sha256(transcript);
  return {
    frameKey: deriveKey(secret, salt, "VAML-0.2/frame-key", 32),
    codebookKey: deriveKey(secret, salt, "VAML-0.2/codebook-key", 32),
    confirmKey: deriveKey(secret, salt, "VAML-0.2/confirm-key", 32),
  };
}

function deriveSessionId(transcript: Buffer): bigint {
  return sha256(transcript).readBigUInt64BE(0);
}

function makeCodebook(concepts: string[], codebookKey: Buffer): {
  conceptToCode: Map<string, bigint>;
  codeToConcept: Map<bigint, string>;
} {
  const conceptToCode = new Map<string, bigint>();
  const codeToConcept = new Map<bigint, string>();

  for (const conceptId of [...new Set(concepts)].sort()) {
    let counter = 0;
    for (;;) {
      const digest = hmacSha256(codebookKey, `${conceptId}|${counter}`);
      const code = digest.readBigUInt64BE(0);
      const existing = codeToConcept.get(code);
      if (!existing || existing === conceptId) {
        conceptToCode.set(conceptId, code);
        codeToConcept.set(code, conceptId);
        break;
      }
      counter += 1;
    }
  }

  return { conceptToCode, codeToConcept };
}

export function finishHandshake(
  pending: PendingHandshake,
  remoteHello: HandshakeHello,
  lexicon: PrivateLexiconPayload,
): NegotiatedSession {
  assertCompatible(pending.hello, remoteHello);
  const transcript = canonicalTranscript(pending.hello, remoteHello);
  const secret = sharedSecret(pending.privateKey, remoteHello.ephemeralPublicKey);
  const keys = deriveSessionKeys(secret, transcript);
  const { conceptToCode, codeToConcept } = makeCodebook(
    lexicon.concepts.map((item) => item.conceptId),
    keys.codebookKey,
  );
  const sessionId = deriveSessionId(transcript);
  const confirmationTag = b64(createHmac("sha256", keys.confirmKey).update(transcript).digest());

  return {
    context: {
      sessionId,
      localAgentId: pending.hello.agentId,
      remoteAgentId: remoteHello.agentId,
      keys,
      sendSequence: 0n,
      receiveSequence: -1n,
    },
    conceptToCode,
    codeToConcept,
    confirmationTag,
  };
}

export function verifyConfirmation(local: NegotiatedSession, remoteTag: string): void {
  const a = Buffer.from(local.confirmationTag);
  const b = Buffer.from(remoteTag);
  if (a.length !== b.length || !createHmac("sha256", local.context.keys.confirmKey).update(a).digest().equals(
    createHmac("sha256", local.context.keys.confirmKey).update(b).digest(),
  )) {
    throw new Error("Handshake confirmation mismatch");
  }
}
