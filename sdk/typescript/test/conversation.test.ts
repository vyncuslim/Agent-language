import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { type AddressInfo } from "node:net";
import test from "node:test";
import {
  PrivateSemanticIndex,
  ValueType,
  connectConversation,
  createPrivatePayload,
  encryptLexicon,
  startConversationServer,
} from "../src/index.js";

test("agents keep one authenticated session across a multi-turn VAML conversation", async () => {
  const key = randomBytes(32);
  const payload = createPrivatePayload(
    [
      { semantic: { machine: [1, 0] }, embedding: [1, 0] },
      { semantic: { machine: [0, 1] }, embedding: [0, 1] },
    ],
    randomBytes(32),
  );
  const pack = encryptLexicon(payload, key);
  const index = new PrivateSemanticIndex(payload);
  const serverConfig = {
    agentId: "agent-b",
    peerId: "agent-a",
    catalogId: pack.packId,
    packKey: key,
    index,
  };

  const serverSessionIds = new Set<bigint>();
  const serverConversationIds = new Set<string>();
  const receivedConceptIds: string[] = [];
  let receivedMessages = 0;

  const server = startConversationServer(
    "127.0.0.1",
    0,
    serverConfig,
    async (message, conversation) => {
      receivedMessages++;
      serverSessionIds.add(conversation.sessionId);
      serverConversationIds.add(message.conversationId);
      receivedConceptIds.push(...message.fields.map((field) => field.conceptId));
      return message.fields;
    },
    { maxTurns: 3, idleTimeoutMs: 30_000, maxHistory: 16 },
  );
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  const clientConfig = {
    ...serverConfig,
    agentId: "agent-a",
    peerId: "agent-b",
  };
  const clientTurns: string[] = [];
  const conversation = await connectConversation(
    "127.0.0.1",
    port,
    clientConfig,
    {
      idleTimeoutMs: 30_000,
      maxHistory: 16,
      onTurn: (turn) => clientTurns.push(`${turn.direction}:${turn.message.messageId}`),
    },
  );

  try {
    const sessionId = conversation.sessionId;
    const conversationId = conversation.conversationId;
    assert.ok(conversationId);

    const first = await conversation.request([
      {
        conceptId: payload.concepts[0].conceptId,
        valueType: ValueType.U64,
        value: 1n,
      },
    ]);
    assert.equal(first.conversationId, conversationId);
    assert.equal(first.fields[0].value, 1n);
    assert.equal(conversation.sessionId, sessionId);
    assert.equal(conversation.runtime.conceptToCode.size, 1);

    const second = await conversation.request([
      {
        conceptId: payload.concepts[1].conceptId,
        valueType: ValueType.Bool,
        value: true,
      },
    ]);
    assert.equal(second.conversationId, conversationId);
    assert.equal(second.fields[0].value, true);
    assert.equal(conversation.sessionId, sessionId);
    assert.equal(conversation.runtime.conceptToCode.size, 2);

    const third = await conversation.request([
      {
        conceptId: payload.concepts[0].conceptId,
        valueType: ValueType.Concept,
        value: payload.concepts[1].conceptId,
      },
    ]);
    assert.equal(third.conversationId, conversationId);
    assert.equal(third.fields[0].value, payload.concepts[1].conceptId);
    assert.equal(conversation.sessionId, sessionId);

    assert.equal(receivedMessages, 3);
    assert.equal(serverSessionIds.size, 1);
    assert.equal(serverConversationIds.size, 1);
    assert.equal(serverConversationIds.has(conversationId!), true);
    assert.deepEqual(receivedConceptIds, [
      payload.concepts[0].conceptId,
      payload.concepts[1].conceptId,
      payload.concepts[0].conceptId,
    ]);

    const context = conversation.context();
    assert.equal(context.length, 6);
    assert.deepEqual(
      context.map((turn) => turn.direction),
      ["sent", "received", "sent", "received", "sent", "received"],
    );
    assert.equal(clientTurns.length, 6);
  } finally {
    conversation.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("conversation messages preserve reply threading and reject duplicate ids", async () => {
  const key = randomBytes(32);
  const payload = createPrivatePayload(
    [{ semantic: { machine: [0.5, 0.5] } }],
    randomBytes(32),
  );
  const pack = encryptLexicon(payload, key);
  const index = new PrivateSemanticIndex(payload);
  const serverConfig = {
    agentId: "thread-b",
    peerId: "thread-a",
    catalogId: pack.packId,
    packKey: key,
    index,
  };

  let requestId = "";
  let replyTarget = "";
  const server = startConversationServer(
    "127.0.0.1",
    0,
    serverConfig,
    async (message) => {
      requestId = message.messageId;
      return message.fields;
    },
    { maxTurns: 1, idleTimeoutMs: 30_000 },
  );
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const conversation = await connectConversation(
    "127.0.0.1",
    port,
    { ...serverConfig, agentId: "thread-a", peerId: "thread-b" },
    { idleTimeoutMs: 30_000 },
  );

  try {
    const sent = await conversation.send([
      {
        conceptId: payload.concepts[0].conceptId,
        valueType: ValueType.None,
      },
    ]);
    const reply = await conversation.receive();
    replyTarget = reply.replyTo ?? "";
    assert.equal(replyTarget, sent.messageId);
    assert.equal(requestId, sent.messageId);

    await assert.rejects(
      () =>
        conversation.send(
          [
            {
              conceptId: payload.concepts[0].conceptId,
              valueType: ValueType.None,
            },
          ],
          { messageId: sent.messageId },
        ),
      /Duplicate conversation message id/,
    );
  } finally {
    conversation.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
