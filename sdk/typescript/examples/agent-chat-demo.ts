/**
 * AI Agent ↔ AI Agent chat in a language humans cannot read.
 *
 * Two stateful agent brains negotiate topics using learned sense concepts.
 * Every turn travels as one pasted VAMLTXT1 text line. This demo prints
 * ONLY opaque material: wire fragments, opaque concept hashes, turn
 * counts. No topic names, no aliases, no translations ever reach the
 * output — a human observer sees nothing but random-looking strings,
 * while the agents demonstrably converse (asserted, not displayed).
 *
 * The demo FAILS if any human-readable word leaks into wire traffic.
 */
import { randomBytes } from "node:crypto";
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
  type SemanticField,
} from "../src/index.js";

const FORBIDDEN_WORDS = ["bank", "finance", "river", "geography", "银行", "河岸", "topic"];

function setupPair(): { a: VamlSessionRuntime; b: VamlSessionRuntime; senses: string[] } {
  const records = [
    { semantic: { x: [0.95, 0.05, 0.31] }, embedding: [0.95, 0.05, 0.31], domains: ["d0"] },
    { semantic: { x: [0.04, 0.93, -0.27] }, embedding: [0.04, 0.93, -0.27], domains: ["d1"] },
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
  const ids = lexicon.concepts.map((c) => c.conceptId);
  aSession.activate(ids);
  bSession.activate(ids);
  return {
    a: new VamlSessionRuntime(aSession.context, aSession.conceptToCode, aSession.codeToConcept),
    b: new VamlSessionRuntime(bSession.context, bSession.conceptToCode, bSession.codeToConcept),
    senses: lexicon.concepts.map((c) => c.conceptId),
  };
}

interface Brain {
  decide(fields: SemanticField[]): SemanticField[] | null;
  seen: Set<string>;
}

/**
 * Quoting protocol (all identities opaque):
 * - agent-a opens with sense0, then quotes back any sense1 it receives.
 * - agent-b answers sense1 until it has seen BOTH sense0 (a's voice) and
 *   sense1 (a quoting it back = mutual understanding confirmed), then ends.
 */
function makeBrain(
  ownConcept: string,
  quoteConcept: string | null,
): Brain {
  const seen = new Set<string>();
  let quoted = false;
  return {
    seen,
    decide(fields: SemanticField[]): SemanticField[] | null {
      for (const f of fields) seen.add(f.conceptId);
      if (seen.size >= 2) return null;
      if (quoteConcept && seen.has(quoteConcept) && !quoted) {
        quoted = true;
        return [{ conceptId: quoteConcept, valueType: ValueType.U64, value: 1n }];
      }
      if (quoteConcept && quoted) return null;
      return [{ conceptId: ownConcept, valueType: ValueType.U64, value: 0n }];
    },
  };
}

export async function agentChatDemo(): Promise<void> {
  const { a, b, senses } = setupPair();
  const [sense0, sense1] = senses;
  const brainA = makeBrain(sense0, sense1);
  const brainB = makeBrain(sense1, null);
  const wireLines: string[] = [];

  let turn: SemanticField[] | null = [{ conceptId: sense0, valueType: ValueType.U64, value: 0n }];
  let sender = a;
  let receiver = b;
  let brain = brainB;
  let turnNo = 0;
  const MAX_TURNS = 16;
  while (turn && turnNo < MAX_TURNS) {
    turnNo++;
    // The ONLY thing crossing between agents: one pasted text line.
    const line = encodeVamlFrameToText(sender.encode(turn));
    wireLines.push(line);
    const from = sender === a ? "agent-a" : "agent-b";
    const to = receiver === a ? "agent-a" : "agent-b";
    console.log(`[turn ${turnNo}] ${from} -> ${to}: ${line.slice(0, 48)}…`);
    const fields = receiver.decode(decodeVamlFrameFromText(line));
    console.log(`          ${to} received opaque concept: ${fields[0].conceptId.slice(0, 16)}…`);
    turn = brain.decide(fields);
    [sender, receiver] = [receiver, sender];
    brain = brain === brainA ? brainB : brainA;
  }
  if (turnNo >= MAX_TURNS) throw new Error("Agent dialogue did not terminate");
  // Mutual comprehension, asserted not displayed: a understood b's voice
  // (sense1), b understood a's voice (sense0) and a's quotation of sense1.
  if (!brainA.seen.has(sense1) || !brainB.seen.has(sense0) || !brainB.seen.has(sense1)) {
    throw new Error("Agents did not negotiate both concepts");
  }
  // Incomprehensibility proof: no human-readable word anywhere on the wire.
  const wireText = wireLines.join("\n").toLowerCase();
  for (const word of FORBIDDEN_WORDS) {
    if (wireText.includes(word.toLowerCase())) {
      throw new Error(`Human-readable leak on the wire: ${word}`);
    }
  }
  console.log(
    `Agent↔Agent chat OK: ${turnNo} pasted turns, both opaque concepts negotiated, ` +
    `0 human-readable words on the wire.`,
  );
}

await agentChatDemo();
