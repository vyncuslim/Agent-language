# VAML 0.1 Specification

Status: Experimental

This document defines the normative core behavior for VAML 0.1.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative requirements.

## 1. Purpose

VAML is a machine-native semantic protocol for communication among AI agents and agent runtimes.

VAML is not intended to be a human conversational language. Human-readable names in the registry are symbolic labels for implementers, debugging, training and interoperability. The wire protocol uses numeric semantic codes and typed payloads.

## 2. Semantic code space

A core semantic code is an unsigned 16-bit integer:

```text
+----------------+----------------+
| namespace u8   | term u8        |
+----------------+----------------+
```

Examples:

```text
0x0101 = communication:TASK
0x0307 = action:SEARCH
0x1104 = evidence:LOG
0xFF01 = protocol_control:BEGIN
```

The canonical mapping is `registry/vaml-core-0.1.json`.

Once a core code is published, its meaning MUST NOT be silently reassigned.

## 3. Frame model

A VAML message consists of a header followed by an ordered sequence of typed semantic fields.

```text
VAML_FRAME := HEADER + FIELD*
```

### 3.1 Header

The canonical binary header is:

| Field | Size | Meaning |
|---|---:|---|
| magic | 2 bytes | ASCII `VA` (`0x56 0x41`) |
| major | 1 byte | protocol major version |
| minor | 1 byte | protocol minor version |
| flags | 1 byte | frame flags |
| reserved | 1 byte | MUST be zero in 0.1 |
| payload_length | 4 bytes | unsigned big-endian payload length |
| frame_id | 8 bytes | sender-selected unsigned frame identifier |

VAML 0.1 uses `major=0`, `minor=1`.

Receivers MUST reject frames with an invalid magic value. Receivers SHOULD reject unsupported major versions. A receiver MAY process a newer compatible minor version only when all mandatory codes are understood.

## 4. Typed semantic field

Each payload field uses TLV form:

```text
+----------------+------------+-------------------+-------------------+
| semantic u16   | type u8    | length u32        | value N bytes     |
+----------------+------------+-------------------+-------------------+
```

All fixed-width integers are network byte order (big-endian).

### 4.1 Value types

| Type | ID | Encoding |
|---|---:|---|
| NONE | `0x00` | length MUST be 0 |
| U64 | `0x01` | unsigned 64-bit integer |
| I64 | `0x02` | signed 64-bit integer |
| F64 | `0x03` | IEEE-754 64-bit float |
| BOOL | `0x04` | one byte, `0x00` or `0x01` |
| BYTES | `0x05` | opaque bytes |
| UTF8 | `0x06` | UTF-8 string; adapters only when unavoidable |
| CODE | `0x07` | nested VAML semantic code, exactly 2 bytes |
| ID128 | `0x08` | 16-byte opaque identifier |
| REF | `0x09` | UTF-8 canonical resource reference |
| VECTOR_F32 | `0x0A` | packed big-endian IEEE-754 float32 sequence |
| NESTED | `0x0B` | nested sequence of VAML TLV fields |

A receiver MUST NOT infer a value type that was not explicitly encoded.

## 5. Canonical semantic composition

The protocol does not force one sentence-like order, but interoperable task frames SHOULD use this conceptual ordering:

```text
BEGIN
MESSAGE_TYPE
SOURCE
TARGET
INTENT/ACTION
OBJECT/RESOURCE
CONSTRAINTS
EVIDENCE/PROVENANCE
EXPECTED_OUTPUT
END
```

Implementations MAY internally represent the frame as a graph rather than a sequence.

## 6. Zero-chatter rule

Agent-to-agent VAML messages SHOULD NOT contain conversational filler. Semantic payloads should encode only information required for coordination, execution, state synchronization, evidence, safety, or error handling.

Do not encode phrases equivalent to:

```text
Hello, happy to help.
Sure, I can do that.
Thank you.
Here is what I found.
```

unless such text is itself the task payload for a human-facing application.

## 7. State delta communication

When synchronizing state, agents SHOULD prefer explicit deltas when this is sufficient:

```text
state_delta:DELTA
world_model:ENTITY <entity-id>
state_delta:FROM <old-state-code>
state_delta:TO <new-state-code>
```

This avoids repeatedly transmitting an entire world description.

## 8. Belief and evidence

Uncertain claims MUST preserve uncertainty when delegated or forwarded.

A belief representation SHOULD include:

- a `CLAIM` or equivalent semantic reference;
- `CONFIDENCE` or `PROBABILITY` when available;
- one or more `EVIDENCE` / `SOURCE` / provenance references when verification matters.

An agent MUST NOT convert an uncertain claim into `FACT` merely because it was received from another agent.

## 9. Capability discovery

Agents MAY advertise capabilities using the discovery and capability namespaces.

A capability advertisement SHOULD specify relevant metadata when available:

```text
CAPABILITY
AVAILABLE / UNAVAILABLE
CAPACITY
COST
LATENCY
QUALITY
RELIABILITY
VERSION
```

A receiving agent MUST NOT assume that an advertised capability grants authorization to invoke it.

## 10. Contract-based delegation

Task delegation MAY be wrapped in a contract containing:

- goal;
- success condition;
- failure condition;
- deadline;
- budget;
- quality requirement;
- constraints;
- permission scope.

Acceptance of a task SHOULD be explicit when the caller depends on guaranteed execution.

## 11. Error behavior

Unknown codes are handled according to whether they are mandatory.

### 11.1 Unknown mandatory code

The receiver MUST NOT guess the meaning. It SHOULD return an error containing concepts equivalent to:

```text
ERROR
UNSUPPORTED
```

### 11.2 Optional extensions

Extensions SHOULD be carried inside an `FF0F EXTENSION` context or be explicitly negotiated. Unsupported optional extensions MAY be ignored while preserving the rest of the frame.

### 11.3 Malformed frame

Malformed length, type, frame boundary, or invalid binary encoding MUST fail closed at the parser layer. No task execution should occur from a malformed frame.

## 12. Security model

VAML syntax and numeric opacity are not security controls.

Production implementations SHOULD provide:

- authenticated transport;
- encryption in transit;
- sender authentication;
- authorization and scope checks;
- replay protection / nonce handling where required;
- message integrity or signatures where required;
- rate limiting;
- sandboxing for untrusted tool execution;
- audit logging.

A syntactically valid VAML command MUST NOT bypass ordinary application policy.

## 13. Registry and domain packs

The VAML core registry is intentionally finite. Domain-specific semantics SHOULD be added as versioned domain packs rather than continuously expanding the core.

Suggested future packs include:

```text
vaml.security
vaml.web
vaml.code
vaml.database
vaml.research
vaml.robotics
vaml.finance
vaml.browser
vaml.memory
vaml.network
```

A domain pack MUST declare:

- pack identifier;
- version;
- code allocation/range;
- dependencies;
- semantic definitions;
- compatibility policy.

## 14. Learning / interoperability procedure

An AI agent learning VAML SHOULD:

1. ingest the core registry;
2. build bidirectional mappings from code to semantic label and semantic label to candidate codes scoped by namespace;
3. ingest protocol composition rules;
4. train/few-shot on examples;
5. preserve namespace context to disambiguate repeated labels such as `SOURCE`, `TARGET`, `STATE`, `ACCEPT`, or `ERROR`;
6. validate generated frames through a parser/encoder before sending them.

## 15. Example task

Conceptual task:

```text
Agent 14 asks Agent 27 to search logs for anomalies with high priority, a 2000 ms timeout, and return evidence.
```

Debug semantic sequence:

```text
FF01
0101
0204 [agent-id:14]
0205 [agent-id:27]
0307
1104
0319 0F1D
0D01 0D04
0C0C [u64:2000]
1906 1101
FF02
```

This debug form is not the normative binary encoding. The normative encoding uses the frame header and TLV structure defined above.

## 16. Compatibility rules

- A VAML 0.1 implementation MUST understand the 0.1 frame header and TLV field format.
- It MAY implement only a subset of semantic namespaces, but MUST safely reject unsupported mandatory semantics.
- It MUST NOT reinterpret a known semantic code.
- It SHOULD preserve unknown optional extension data when acting as a transparent relay.

## 17. Human adapters

Human-facing translation is an adapter layer only:

```text
Human text <-> semantic object <-> VAML frame <-> semantic object <-> agent
```

The VAML protocol itself is the semantic object/frame exchange, not the human sentence on either side.
