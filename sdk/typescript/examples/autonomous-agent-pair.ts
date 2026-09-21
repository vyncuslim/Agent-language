import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  PrivateSemanticIndex,
  ValueType,
  createPrivatePayload,
  encryptLexicon,
  runAgentDialogue,
  startAgentServer,
  type SemanticField,
} from "../src/index.js";

const packKey = randomBytes(32);
const payload = createPrivatePayload(
  [
    {
      semantic: { machine: "autonomous-agent-example-state" },
      domains: ["example"],
    },
  ],
  randomBytes(32),
);
const pack = encryptLexicon(payload, packKey);
const index = new PrivateSemanticIndex(payload);
const conceptId = payload.concepts[0].conceptId;

const agentB = {
  agentId: "agent-b",
  peerId: "agent-a",
  catalogId: pack.packId,
  packKey,
  index,
};
const agentA = { ...agentB, agentId: "agent-a", peerId: "agent-b" };

const server = startAgentServer(
  "127.0.0.1",
  0,
  agentB,
  async (context): Promise<SemanticField[]> => {
    const current = context.message.fields[0].value as bigint;
    return [{ conceptId, valueType: ValueType.U64, value: current + 1n }];
  },
  { maxTurns: 32 },
);

await once(server, "listening");
const port = (server.address() as AddressInfo).port;

try {
  const result = await runAgentDialogue(
    "127.0.0.1",
    port,
    agentA,
    async (context): Promise<SemanticField[] | null> => {
      const current = context.message.fields[0].value as bigint;
      if (current >= 8n) return null;
      return [{ conceptId, valueType: ValueType.U64, value: current + 1n }];
    },
    [{ conceptId, valueType: ValueType.U64, value: 1n }],
    { maxAgentTurns: 16 },
  );

  console.log(
    JSON.stringify({
      conversation: result.conversationId,
      session: result.sessionId.toString(),
      turns: result.history.length,
      localReplies: result.localReplies,
    }),
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
