/**
 * AI Agent ↔ VAMLTXT proof: two autonomous agent brains hold a multi-turn
 * dialogue where EVERY wire message is a pasted VAMLTXT1 text line.
 * No TCP, no shared memory between turns — only copy/paste text.
 *
 * Proves: model-neutral agent brains can converse over text transport,
 * termination by null works, and a tampered pasted line fails closed
 * instead of hijacking the dialogue.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  ValueType,
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
  type SemanticField,
} from "../src/index.js";

function sessionPair(): { a: VamlSessionRuntime; b: VamlSessionRuntime; concept: string } {
  const records: ConceptSourceRecord[] = [
    { semantic: { z: [0.5, -0.5, 0.25] }, embedding: [0.5, -0.5, 0.25], domains: ["text-dialogue"] },
  ];
  const lexicon = createPrivatePayload(records, randomBytes(32));
  const pack = encryptLexicon(lexicon, randomBytes(32));
  const authKey = randomBytes(32);
  const aPending = beginHandshake("agent-a", defaultManifest([pack.packId]));
  const bPending = beginHandshake("agent-b", defaultManifest([pack.packId]));
  const index = new PrivateSemanticIndex(lexicon);
  const aSession = finishHandshake(aPending, bPending.hello, index, authKey, "agent-b");
  const bSession = finishHandshake(bPending, aPending.hello, index, authKey, "agent-a");
  verifyConfirmation(aSession, bSession.confirmationTag);
  verifyConfirmation(bSession, aSession.confirmationTag);
  const concept = lexicon.concepts[0].conceptId;
  aSession.activate([concept]);
  bSession.activate([concept]);
  return {
    a: new VamlSessionRuntime(aSession.context, aSession.conceptToCode, aSession.codeToConcept),
    b: new VamlSessionRuntime(bSession.context, bSession.conceptToCode, bSession.codeToConcept),
    concept,
  };
}

type Brain = (fields: SemanticField[]) => SemanticField[] | null;

/** One paste step: fields -> sealed -> VAMLTXT1 line (the clipboard). */
function paste(sender: VamlSessionRuntime, fields: SemanticField[]): string {
  const line = encodeVamlFrameToText(sender.encode(fields));
  assert.match(line, /^VAMLTXT1\.[A-Za-z0-9_-]+\.[0-9a-f]{8}$/);
  assert.ok(!/\s/.test(line));
  return line;
}

/** The peer pastes the line back: text -> exact bytes -> opened fields. */
function receive(receiver: VamlSessionRuntime, line: string): SemanticField[] {
  return receiver.decode(decodeVamlFrameFromText(line));
}

test("two AI agent brains converse purely through pasted VAMLTXT1 lines", () => {
  const { a, b, concept } = sessionPair();
  const seen: bigint[] = [];
  const brainA: Brain = (fields) => {
    const current = fields[0].value as bigint;
    seen.push(current);
    if (current >= 8n) return null;
    return [{ conceptId: concept, valueType: ValueType.U64, value: current + 1n }];
  };
  const brainB: Brain = (fields) => {
    const current = fields[0].value as bigint;
    seen.push(current);
    if (current >= 8n) return null;
    return [{ conceptId: concept, valueType: ValueType.U64, value: current + 1n }];
  };

  let turn: SemanticField[] | null = [{ conceptId: concept, valueType: ValueType.U64, value: 1n }];
  let pastes = 0;
  let sender = a;
  let receiver = b;
  let brain = brainB;
  while (turn) {
    const line = paste(sender, turn); // Agent copies this ONE line to the peer.
    pastes++;
    const fields = receive(receiver, line); // Peer pastes it back.
    turn = brain(fields);
    [sender, receiver] = [receiver, sender];
    brain = brain === brainA ? brainB : brainA;
    assert.ok(pastes < 32, "dialogue must terminate");
  }
  assert.deepEqual(seen, [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
  assert.ok(pastes >= 8, "every turn traveled as a pasted text line");
});

test("a tampered pasted line cannot hijack the agent dialogue", () => {
  const { a, b, concept } = sessionPair();
  const line = paste(a, [{ conceptId: concept, valueType: ValueType.U64, value: 1n }]);
  const [, payload, checksum] = line.split(".");
  const tampered = `VAMLTXT1.${payload.slice(0, 20)}${payload[20] === "A" ? "B" : "A"}${payload.slice(21)}.${checksum}`;
  assert.throws(() => receive(b, tampered), /CRC/);
  // The dialogue itself is undisturbed: the original line still opens.
  const fields = receive(b, line);
  assert.equal(fields[0].value, 1n);
});
