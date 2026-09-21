import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  PrivateSemanticIndex,
  ValueType,
  createPrivatePayload,
  encryptLexicon,
  runAgentDialogue,
  startAgentServer,
  type AgentBrainContext,
  type SemanticField,
} from "../src/index.js";

function numericValue(context: AgentBrainContext): bigint {
  const field = context.message.fields[0];
  assert.equal(field.valueType, ValueType.U64);
  assert.equal(typeof field.value, "bigint");
  return field.value as bigint;
}

function setupConfigs(machine: string) {
  const key = randomBytes(32);
  const payload = createPrivatePayload(
    [{ semantic: { machine }, domains: ["synthetic-test"] }],
    randomBytes(32),
  );
  const pack = encryptLexicon(payload, key);
  const conceptId = payload.concepts[0].conceptId;
  const index = new PrivateSemanticIndex(payload);
  const serverConfig = {
    agentId: "agent-b",
    peerId: "agent-a",
    catalogId: pack.packId,
    packKey: key,
    index,
  };
  const clientConfig = { ...serverConfig, agentId: "agent-a", peerId: "agent-b" };
  return { conceptId, serverConfig, clientConfig };
}

test("two autonomous AI Agent brains communicate over one persistent VAML conversation", async () => {
  const { conceptId, serverConfig, clientConfig } = setupConfigs("autonomous-dialogue-counter");
  const serverValues: bigint[] = [];
  const serverSessions = new Set<bigint>();
  const serverConversations = new Set<string>();

  const server = startAgentServer(
    "127.0.0.1",
    0,
    serverConfig,
    async (context): Promise<SemanticField[]> => {
      const value = numericValue(context);
      serverValues.push(value);
      serverSessions.add(context.sessionId);
      if (context.conversationId) serverConversations.add(context.conversationId);
      return [{ conceptId, valueType: ValueType.U64, value: value + 1n }];
    },
    { maxTurns: 16 },
  );

  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const clientValues: bigint[] = [];
  const clientSessions = new Set<bigint>();
  const clientConversations = new Set<string>();

  try {
    const result = await runAgentDialogue(
      "127.0.0.1",
      port,
      clientConfig,
      async (context): Promise<SemanticField[] | null> => {
        const value = numericValue(context);
        clientValues.push(value);
        clientSessions.add(context.sessionId);
        if (context.conversationId) clientConversations.add(context.conversationId);
        if (value >= 6n) return null;
        return [{ conceptId, valueType: ValueType.U64, value: value + 1n }];
      },
      [{ conceptId, valueType: ValueType.U64, value: 1n }],
      { maxAgentTurns: 8, maxHistory: 32 },
    );

    assert.deepEqual(serverValues, [1n, 3n, 5n]);
    assert.deepEqual(clientValues, [2n, 4n, 6n]);
    assert.equal(result.localReplies, 2);
    assert.equal(result.history.length, 6);
    assert.equal(result.lastMessage?.fields[0].value, 6n);
    assert.equal(serverSessions.size, 1);
    assert.equal(clientSessions.size, 1);
    assert.deepEqual([...serverSessions], [...clientSessions]);
    assert.equal(serverConversations.size, 1);
    assert.equal(clientConversations.size, 1);
    assert.deepEqual([...serverConversations], [...clientConversations]);
    assert.equal(result.conversationId, [...clientConversations][0]);

    for (let i = 1; i < result.history.length; i++) {
      const previous = result.history[i - 1].message;
      const current = result.history[i].message;
      assert.equal(current.replyTo, previous.messageId);
      assert.equal(current.conversationId, previous.conversationId);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("peer Agent can end a dialogue immediately without waiting for idle timeout", async () => {
  const { conceptId, serverConfig, clientConfig } = setupConfigs("autonomous-dialogue-stop");
  const server = startAgentServer(
    "127.0.0.1",
    0,
    serverConfig,
    async () => null,
    { idleTimeoutMs: 60_000 },
  );
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  try {
    const started = Date.now();
    const result = await runAgentDialogue(
      "127.0.0.1",
      port,
      clientConfig,
      async () => null,
      [{ conceptId, valueType: ValueType.U64, value: 1n }],
      { idleTimeoutMs: 60_000 },
    );
    assert.ok(Date.now() - started < 5_000, "peer termination should not wait for idle timeout");
    assert.equal(result.localReplies, 0);
    assert.equal(result.lastMessage, undefined);
    assert.equal(result.history.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
