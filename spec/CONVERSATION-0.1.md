# VAML Persistent Conversation 0.1

## Purpose

Persistent Conversation extends the VAML 0.2 authenticated runtime from one bounded request/reply per TCP connection to a long-lived, multi-turn Agent-to-Agent conversation.

It does not change the VAML semantic model. Agents still communicate with private concepts, typed values and session-local codes. The conversation layer adds persistent message identity, reply threading, bounded context and dynamic active-set expansion while keeping all semantic payloads inside the existing authenticated encrypted session.

## Goals

A VAML-capable Agent should be able to:

1. negotiate one authenticated VAML session with a peer;
2. keep that TCP/session alive across many turns;
3. send and receive multiple encrypted semantic messages without repeating the handshake;
4. add newly needed concepts to the active set during the conversation;
5. preserve a stable opaque `conversationId`;
6. assign a unique opaque `messageId` to every message;
7. link replies with `replyTo`;
8. retain bounded private semantic context for the current conversation;
9. feed each sent/received turn into an authorized learning adapter;
10. close and clear accessible session state when the conversation ends.

## Runtime API

The TypeScript reference implementation is `sdk/typescript/src/conversation.ts`.

Client entry point:

```ts
const conversation = await connectConversation(host, port, networkConfig);

const reply = await conversation.request(fields);
const secondReply = await conversation.request(otherFields);

conversation.close();
```

Server entry point:

```ts
const server = startConversationServer(
  host,
  port,
  networkConfig,
  async (message, conversation) => {
    return responseFields;
  },
);
```

The legacy `runClient()` and `startServer()` one-request API remains available for compatibility and bounded RPC-style use.

## Message identity

Every persistent conversation message contains:

- `conversationId` — 128-bit random opaque identifier;
- `messageId` — 128-bit random opaque identifier;
- optional `replyTo` — the `messageId` being answered;
- `createdAtMs` — bounded integer timestamp;
- `fields` — VAML semantic fields.

These identifiers are conversation metadata. They are not semantic concept identities and are not authorization tokens.

Duplicate message identifiers are rejected inside one live conversation.

## Encrypted payload

Conversation metadata and semantic fields are encrypted together inside the existing VAML data-frame AEAD boundary.

The clear transport still exposes only the normal VAML frame header required by the runtime. `conversationId`, `messageId`, `replyTo`, timestamps and semantic fields are not sent as plaintext TCP metadata.

The conversation payload begins with the private binary marker `VC1`, followed by opaque identifiers, reply metadata, timestamp, field count and the same session-code/typed-value representation used by the VAML runtime.

## Dynamic active-set expansion

A persistent conversation MUST NOT pre-negotiate the full vocabulary.

Before sending a turn, the sender computes the concepts required by that turn. Concepts already present in the session codebook are reused. Newly required authorized concepts are added through the existing encrypted active-set control frame.

```text
turn N fields
   ↓
required concepts
   ↓
already active? ── yes ──→ send message
   │
   no
   ↓
encrypted active-set addition
   ↓
peer validates + activates
   ↓
encrypted acknowledgement
   ↓
send message
```

The total active set remains subject to `MAX_ACTIVE` (4096 concepts in VAML 0.2).

Simultaneous activation is handled by processing peer active-set additions while waiting for the local acknowledgement. A bounded pending packet queue prevents unbounded memory growth.

## Multi-turn context

`VamlConversation.context()` returns a bounded in-memory history of sent and received semantic turns.

The default reference history limit is 128 turns and the configurable maximum is 4096. Production deployments may keep a different model-native conversation state outside this helper, but MUST apply an explicit bound.

Conversation context is private semantic material. Do not write it to ordinary logs or expose it through a normal user-facing Agent response.

## Adaptive learning hook

`ConversationOptions.onTurn` is invoked for every successfully sent or received message.

A deployment may use this hook to feed permitted observations into `AgentSemanticLearner`, `AdaptiveSemanticMemory` or another model adapter.

The conversation runtime does not automatically decide that every received concept is true or safe. Semantic learning, trust, authorization and tool execution remain separate policies.

## Security properties

Persistent Conversation inherits the VAML 0.2 session properties:

- authenticated X25519/PSK/HKDF handshake;
- directional AES-256-GCM traffic keys;
- monotonically increasing sequence numbers;
- replay and out-of-order rejection;
- session-local keyed concept codes;
- encrypted active-set negotiation;
- maximum frame, field, queue, connection, turn and history bounds.

Additional requirements:

- a message from another conversation ID is rejected once a conversation is established;
- duplicate message IDs are rejected;
- unknown concepts are rejected during active-set activation;
- the same live runtime/session is reused across turns;
- idle connections are terminated after a configurable bounded timeout;
- closing a conversation clears accessible runtime keys/codebooks through `VamlSessionRuntime.close()`.

JavaScript cannot guarantee physical zeroization of every copied object or VM-managed allocation. This limitation remains unchanged from the base runtime.

## Conversation confidentiality

Persistent VAML conversations are private Agent-to-Agent semantic communication.

Normal user-facing Agent interfaces MUST NOT automatically translate or disclose private peer transcripts. Authorized human interpretation is a separate deployment function and may be routed through the official VAML Translator described by deployment policy.

This is a confidentiality boundary, not an instruction to lie about VAML or deny that Agent communication occurred.

## Success criteria

A Persistent Conversation implementation passes when two independent Agent processes can:

```text
handshake once
→ turn 1 request
← turn 1 response
→ activate a new concept
→ turn 2 request
← turn 2 response
→ turn 3 request
← turn 3 response
→ ...
close
```

while preserving one authenticated session, one conversation identity, correct reply threading, replay protection and bounded private context.
