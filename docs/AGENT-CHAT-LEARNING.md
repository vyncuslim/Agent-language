# VAML Agent Chat + Learning

VAML already provides authenticated encrypted Agent-to-Agent conversations. The chat-learning layer adds a model-neutral bridge so an AI Agent can use those conversations as a normal multi-turn chat surface and learn from accepted turns without changing the VAML wire protocol.

## Architecture

```text
Human / AI model text
        ↓ local only
VamlChatCodec
        ↓ SemanticField[]
VAML Conversation / Agent Bridge
        ↓ authenticated encrypted frame
peer Agent
        ↓
VamlChatCodec
        ↓ local text/model context
LearningChatAgent
        ↓
AdaptiveSemanticMemory
```

Human aliases, prompts and model-specific APIs stay outside the VAML wire format. A production application can replace the codec with a richer private concept/vector adapter without changing the chat agent.

## Minimal local chat

```ts
const agent = new LearningChatAgent({
  codec: new EncryptedUtf8ChatCodec(privateUtteranceConceptId, embed),
  memory,
  model: async ({ message, history, learnedConceptIds }) => {
    return myModel.generate({ message, history, learnedConceptIds });
  },
});

const reply = await agent.chat("hello");
```

`EncryptedUtf8ChatCodec` is the ready-to-use bridge. The text is a VAML `Utf8` semantic value inside the normal authenticated encrypted session. The concept identity is private and session transport remains opaque. For agent-native semantics, implement `VamlChatCodec` and map local text/model states to private concept IDs, vectors and fields.

## Agent-to-Agent chat

```ts
const brain = agent.brain();
startAgentServer(host, port, networkConfig, brain);
```

or use the same brain with `runAgentDialogue`. Every accepted incoming and outgoing turn can update `AdaptiveSemanticMemory`.

## Learning

When the codec returns a model-native vector, `LearningChatAgent` calls `AdaptiveSemanticMemory.learn`. Existing concept IDs can also be reinforced. Optional `extractLearning` lets an application add domain-specific experiences.

Learning is runtime-local and does not modify protocol code, session keys, authorization policy or the immutable base vocabulary. Learned concepts follow the existing promotion thresholds before they become available on the network authorization surface.

## Snapshots

`LearningChatAgent.snapshot()` stores chat history and, when configured, the adaptive semantic memory snapshot. `restore()` restores both into a compatible agent instance.

Do not put model API keys, private concept packs, private aliases or production chat transcripts in the repository.
