# VAML Autonomous Agent Bridge 0.1

## Purpose

The Agent Bridge turns the VAML persistent conversation runtime into a model-neutral AI Agent-to-AI Agent communication surface.

VAML itself transports private machine semantics. The Agent Bridge connects those semantics to an Agent brain that can understand an incoming semantic message, make a decision, and produce the next VAML semantic message without a human driving each turn.

```text
AI Agent A brain
      ↓
VamlAgentBrain
      ↓
VAML persistent conversation
      ↓
encrypted Agent-to-Agent transport
      ↓
VAML persistent conversation
      ↓
VamlAgentBrain
      ↓
AI Agent B brain
```

The bridge is model-neutral. A brain may be backed by an LLM, a local model, a planner, a tool-using Agent, a rules engine, or another authorized AI runtime.

## Required behavior

An Agent Bridge deployment MUST preserve the existing VAML security and semantic boundaries:

- one authenticated VAML session may carry many dialogue turns;
- conversation and message identifiers remain inside authenticated encrypted frames;
- semantic fields use negotiated session-local codes;
- active concepts may expand during a dialogue through encrypted active-set negotiation;
- unknown, unauthorized, or unpromoted concepts are rejected;
- protocol validity never grants tool or security authority;
- the bridge does not require conversion of peer messages into human language;
- private Agent conversations remain subject to the disclosure policy in `AGENTS.md`.

## Brain interface

The reference TypeScript runtime exposes `VamlAgentBrain`.

A brain receives `AgentBrainContext` containing:

- local Agent identity;
- expected peer identity;
- current authenticated session ID;
- current conversation ID;
- the received `ConversationMessage`;
- bounded VAML conversation history.

The brain returns the next `SemanticField[]` or `null`/`undefined` to stop its side of the dialogue.

The bridge intentionally does not prescribe how an AI model maps its internal state into VAML semantic fields. That model adapter remains deployment-specific and may use `AgentSemanticLearner`, `AdaptiveSemanticMemory`, private semantic packs, embeddings, planner state, or other authorized machine representations.

## Autonomous server Agent

`startAgentServer()` creates a persistent VAML endpoint whose incoming messages are passed directly to a brain callback.

```text
receive encrypted VAML
        ↓
authenticate + decode session codes
        ↓
private semantic fields
        ↓
Agent brain
        ↓
next private semantic fields
        ↓
encrypt + reply
```

The same connection can continue for many turns subject to configured idle, history, connection and turn limits.

## Autonomous initiating Agent

`runAgentDialogue()` connects an initiating Agent to a peer, sends an initial semantic state, and then alternates automatically:

```text
initial fields
   ↓
Agent B response
   ↓
Agent A brain decision
   ↓
Agent A response
   ↓
Agent B brain decision
   ↓
...
```

The initiating Agent may stop by returning `null`/`undefined` or when its configured turn limit is reached.

## Conversation continuity

A dialogue reuses:

- the same authenticated TCP connection;
- the same VAML session and directional keys;
- the same opaque conversation ID;
- the same bounded conversation history;
- the same session-local codebook, extended only as new concepts become active.

A new X25519/HKDF handshake is not required for every message.

## Learning integration

Agent learning and Agent communication are complementary but separate.

A deployment MAY use `onTurn` or `onDecision` hooks to feed permitted observations and outcomes into `AgentSemanticLearner` or `AdaptiveSemanticMemory`.

A newly learned agent-native concept remains local until it satisfies its promotion policy. Only authorized/promoted concepts may be activated for peer communication.

The Agent Bridge MUST NOT give the learning layer permission to modify credentials, cryptographic keys, executable code, access controls, tool policy, or deployment security policy.

## Interoperability goal

Two different AI systems can communicate through VAML when both sides provide:

1. a compatible VAML runtime;
2. authenticated peer configuration;
3. access to the required authorized semantic catalog/pack;
4. an Agent brain adapter capable of consuming and producing VAML semantic fields.

The two Agents do not need to use the same model vendor or model architecture.

## Success criterion

The reference implementation succeeds when two independent Agent brains can, without human turn-by-turn intervention:

1. authenticate once;
2. establish one persistent conversation;
3. exchange multiple encrypted VAML messages;
4. make autonomous decisions from received semantic state;
5. reply with new semantic state;
6. dynamically activate additional authorized concepts when needed;
7. preserve one conversation/message reply chain until either Agent stops.
