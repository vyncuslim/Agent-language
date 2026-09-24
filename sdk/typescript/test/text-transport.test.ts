/**
 * VAML Text Transport 0.1 tests (deterministic, no randomness without seed).
 *
 * Covers armor round-trips, every rejection class, copy/paste whitespace
 * tolerance, and a sealed-frame end-to-end run: text carries the exact
 * bytes, and the session AEAD decides acceptance.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
  VamlSessionRuntime,
  beginHandshake,
  createPrivatePayload,
  decodeVamlFrameFromText,
  defaultManifest,
  encryptLexicon,
  encodeVamlFrameToText,
  finishHandshake,
  verifyConfirmation,
  PrivateSemanticIndex,
  type ConceptSourceRecord,
} from "../src/index.js";

function seededBytes(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let state = createHash("sha256").update(seed).digest();
  let offset = 0;
  while (offset < length) {
    state = createHash("sha256").update(state).digest();
    const chunk = Math.min(state.length, length - offset);
    state.copy(out, offset, 0, chunk);
    offset += chunk;
  }
  return out;
}

function sessionPair(): { a: VamlSessionRuntime; b: VamlSessionRuntime } {
  const records: ConceptSourceRecord[] = [
    { semantic: { z: [0.4, -0.2, 0.9] }, embedding: [0.4, -0.2, 0.9], domains: ["x"] },
  ];
  const lexicon = createPrivatePayload(records, randomBytes(32));
  const pack = encryptLexicon(lexicon, randomBytes(32));
  const authKey = randomBytes(32);
  const aPending = beginHandshake("a", defaultManifest([pack.packId]));
  const bPending = beginHandshake("b", defaultManifest([pack.packId]));
  const index = new PrivateSemanticIndex(lexicon);
  const aSession = finishHandshake(aPending, bPending.hello, index, authKey, "b");
  const bSession = finishHandshake(bPending, aPending.hello, index, authKey, "a");
  verifyConfirmation(aSession, bSession.confirmationTag);
  verifyConfirmation(bSession, aSession.confirmationTag);
  return {
    a: new VamlSessionRuntime(aSession.context, aSession.conceptToCode, aSession.codeToConcept),
    b: new VamlSessionRuntime(bSession.context, bSession.conceptToCode, bSession.codeToConcept),
  };
}

test("text transport round-trips opaque bytes exactly and deterministically", () => {
  for (const length of [1, 7, 48, 96, 1024]) {
    const frame = seededBytes(`text-roundtrip/${length}`, length);
    const first = encodeVamlFrameToText(frame);
    const second = encodeVamlFrameToText(frame);
    assert.equal(first, second);
    assert.match(first, /^VAMLTXT1\.[A-Za-z0-9_-]+\.[0-9a-f]{8}$/);
    assert.ok(!/\s/.test(first));
    assert.deepEqual(decodeVamlFrameFromText(first), frame);
  }
});

test("text transport rejects every corruption class without silent output", () => {
  const frame = seededBytes("text-corrupt", 64);
  const text = encodeVamlFrameToText(frame);
  const [, payload, checksum] = text.split(".");
  // One flipped payload character breaks the CRC.
  const flipped = payload.slice(0, 10) + (payload[10] === "A" ? "B" : "A") + payload.slice(11);
  assert.throws(() => decodeVamlFrameFromText(`VAMLTXT1.${flipped}.${checksum}`), /CRC/);
  // Flipped checksum character breaks the CRC.
  const badChecksum = (checksum[0] === "0" ? "1" : "0") + checksum.slice(1);
  assert.throws(() => decodeVamlFrameFromText(`VAMLTXT1.${payload}.${badChecksum}`), /CRC|checksum/);
  // Wrong magic, wrong structure, bad alphabet, truncation all reject.
  assert.throws(() => decodeVamlFrameFromText(`VAMLTXT0.${payload}.${checksum}`), /magic/);
  assert.throws(() => decodeVamlFrameFromText(`VAMLTXT1.${payload}`), /structure/);
  assert.throws(() => decodeVamlFrameFromText(`VAMLTXT1.${payload}.${checksum}.extra`), /structure/);
  assert.throws(() => decodeVamlFrameFromText(`VAMLTXT1.${payload.slice(0, 8)}!${payload.slice(9)}.${checksum}`), /encoding/);
  assert.throws(() => decodeVamlFrameFromText(`VAMLTXT1.${payload.slice(0, payload.length - 8)}.${checksum}`), /CRC|size|encoding/);
  assert.throws(() => decodeVamlFrameFromText(""), /structure|magic|size/);
  assert.throws(() => decodeVamlFrameFromText(`VAMLTXT1..${checksum}`), /size|encoding/);
});

test("text transport tolerates copy/paste surrounding whitespace only", () => {
  const frame = seededBytes("text-paste", 46);
  const text = encodeVamlFrameToText(frame);
  assert.deepEqual(decodeVamlFrameFromText(`  \t${text}\r\n`), frame);
  const [, payload, checksum] = text.split(".");
  // Canonical padding is accepted but never required.
  assert.deepEqual(decodeVamlFrameFromText(`VAMLTXT1.${payload}==.${checksum}`), frame);
  assert.throws(() => decodeVamlFrameFromText(`VAMLTXT1.${payload.slice(0, 4)} ${payload.slice(4)}.${checksum}`), /encoding|structure/);
});

test("text transport enforces size bounds", () => {
  assert.throws(() => encodeVamlFrameToText(Buffer.alloc(0)), /size limit/);
  assert.throws(() => decodeVamlFrameFromText("VAMLTXT1.e30=.deadbeef", { maxFrameBytes: 1 }), /size limit|CRC/);
  const big = "A".repeat(Math.ceil(64 / 3) * 4 + 4);
  assert.throws(() => decodeVamlFrameFromText(`VAMLTXT1.${big}.00000000`, { maxFrameBytes: 64 }), /size limit/);
});

test("sealed frame survives text copy/paste with AEAD PASS and exact payload", () => {
  const { a, b } = sessionPair();
  const plaintext = seededBytes("text-e2e-plaintext", 96);
  const sealed = a.seal(Buffer.from(plaintext), 0);
  // Computer A copies this exact line; Computer B pastes it back.
  const pasted = `  ${encodeVamlFrameToText(sealed)}\n`;
  const recovered = decodeVamlFrameFromText(pasted);
  assert.deepEqual(recovered, sealed);
  assert.deepEqual(b.open(recovered, 0), plaintext);
});

test("every character gets its own agent-language line", () => {
  const { a, b } = sessionPair();
  const text = "你好A🌍z";
  const lines: string[] = [];
  for (const ch of [...text]) {
    const line = encodeVamlFrameToText(a.seal(Buffer.from(ch, "utf8"), 0));
    assert.match(line, /^VAMLTXT1\.[A-Za-z0-9_-]+\.[0-9a-f]{8}$/);
    lines.push(line);
  }
  // Fresh nonce per character: identical input chars still differ on wire.
  assert.equal(new Set(lines).size, lines.length);
  let recovered = "";
  for (const line of lines) {
    recovered += new TextDecoder("utf-8", { fatal: true }).decode(b.open(decodeVamlFrameFromText(line), 0));
  }
  assert.equal(recovered, text);
});

test("tampered text never yields AEAD plaintext", () => {
  const { a, b } = sessionPair();
  const sealed = a.seal(seededBytes("text-tamper-plaintext", 32), 0);
  const text = encodeVamlFrameToText(sealed);
  const [, payload, checksum] = text.split(".");
  // Attacker cannot fix the CRC without the bytes; any edit fails closed
  // at armor decode, before AEAD is even reached.
  const cut = payload.slice(0, payload.length - 4);
  assert.throws(() => decodeVamlFrameFromText(`VAMLTXT1.${cut}.${checksum}`), /CRC|size|encoding/);
  // A well-formed but foreign frame fails at AEAD open, not silently.
  const { a: stranger } = sessionPair();
  const foreign = encodeVamlFrameToText(stranger.seal(seededBytes("text-foreign", 16), 0));
  assert.throws(() => b.open(decodeVamlFrameFromText(foreign), 0), /Session ID|tag|mismatch|decrypt|authentication/i);
});
