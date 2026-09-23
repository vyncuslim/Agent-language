import { randomBytes } from "node:crypto";
import { AdaptiveSemanticMemory } from "../src/adaptive-memory.js";
import { EncryptedUtf8ChatCodec, LearningChatAgent } from "../src/chat-learning.js";
import { conceptId, createPrivatePayload } from "../src/lexicon.js";
import { PrivateSemanticIndex } from "../src/semantic-index.js";

const semanticKey = randomBytes(32);
const learningKey = randomBytes(32);

try {
  const record = { semantic: { kind: "private-chat-utterance", version: 1 } };
  const utteranceId = conceptId(semanticKey, record);
  const index = new PrivateSemanticIndex(createPrivatePayload([record], semanticKey));
  const memory = new AdaptiveSemanticMemory(index, learningKey);
  const codec = new EncryptedUtf8ChatCodec(utteranceId, (text) => {
    const bytes = Buffer.from(text, "utf8");
    const vector = [0, 0, 0, 0];
    for (let i = 0; i < bytes.length; i++) vector[i % vector.length] += bytes[i] / 255;
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  });

  const agent = new LearningChatAgent({
    codec,
    memory,
    learningDomain: "demo-chat",
    model: ({ message, learnedConceptIds }) => `I received “${message}”. Learned private concepts: ${learnedConceptIds.length}.`,
  });

  console.log("USER:", "Hello VAML");
  console.log("AGENT:", await agent.chat("Hello VAML"));
  console.log("USER:", "Remember this conversation");
  console.log("AGENT:", await agent.chat("Remember this conversation"));
  console.log("HISTORY_TURNS", agent.history().length);
  console.log("LEARNED_CONCEPTS", memory.snapshot().concepts.length);
  memory.close();
} finally {
  semanticKey.fill(0);
  learningKey.fill(0);
}
