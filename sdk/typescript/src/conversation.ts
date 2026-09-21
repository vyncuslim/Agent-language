import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { b64, unb64 } from "./crypto.js";
import { MAX_ACTIVE, type NegotiatedSession } from "./negotiation.js";
import {
  MAX_FIELDS,
  VamlSessionRuntime,
  decodeValue,
  encodeValue,
} from "./runtime.js";
import {
  PacketChannel,
  negotiate,
  type NetworkConfig,
} from "./transport.js";
import { ValueType, type SemanticField } from "./types.js";

const CONVERSATION_MAGIC = Buffer.from("VC1");
const OPAQUE_ID_BYTES = 16;
const FIELD_HEADER_BYTES = 13;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_TURNS = 1024;
const DEFAULT_MAX_HISTORY = 128;
const DEFAULT_MAX_CONNECTIONS = 16;

export interface ConversationMessage {
  conversationId: string;
  messageId: string;
  replyTo?: string;
  createdAtMs: number;
  fields: SemanticField[];
}

export interface ConversationTurn {
  direction: "sent" | "received";
  message: ConversationMessage;
}

export interface ConversationSendOptions {
  messageId?: string;
  replyTo?: string;
  createdAtMs?: number;
}

export interface ConversationOptions {
  conversationId?: string;
  idleTimeoutMs?: number;
  maxHistory?: number;
  onTurn?: (turn: ConversationTurn) => void | Promise<void>;
}

export interface ConversationServerOptions extends ConversationOptions {
  maxTurns?: number;
  maxConnections?: number;
}

export type ConversationResponder = (
  message: ConversationMessage,
  conversation: VamlConversation,
) =>
  | SemanticField[]
  | null
  | undefined
  | Promise<SemanticField[] | null | undefined>;

function newOpaqueId(): string {
  return b64(randomBytes(OPAQUE_ID_BYTES));
}

function parseOpaqueId(value: string, label: string): Buffer {
  const decoded = unb64(value);
  if (decoded.length !== OPAQUE_ID_BYTES) throw new Error(`Invalid ${label}`);
  return decoded;
}

function frameKind(frame: Buffer): 0 | 1 | 2 {
  if (
    frame.length < 5 ||
    frame[0] !== 86 ||
    frame[1] !== 50 ||
    frame[2] !== 0 ||
    frame[3] !== 2 ||
    frame[4] > 2
  ) {
    throw new Error("Invalid VAML conversation frame");
  }
  return frame[4] as 0 | 1 | 2;
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return structuredClone(message);
}

function collectConceptIds(fields: SemanticField[]): string[] {
  return [
    ...new Set(
      fields.flatMap((field) =>
        field.valueType === ValueType.Concept
          ? [field.conceptId, field.value as string]
          : [field.conceptId],
      ),
    ),
  ];
}

export class VamlConversation {
  private closed = false;
  private conversationIdentity: string | undefined;
  private readonly pendingPackets: Buffer[] = [];
  private readonly turns: ConversationTurn[] = [];
  private readonly receivedMessageIds = new Set<string>();
  private readonly sentMessageIds = new Set<string>();
  private readonly maxHistory: number;
  private readonly onTurn?: ConversationOptions["onTurn"];

  constructor(
    readonly channel: PacketChannel,
    readonly session: NegotiatedSession,
    readonly runtime: VamlSessionRuntime,
    readonly config: NetworkConfig,
    options: ConversationOptions = {},
  ) {
    this.conversationIdentity = options.conversationId;
    if (this.conversationIdentity) {
      parseOpaqueId(this.conversationIdentity, "conversation id");
    }
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1) {
      throw new Error("Invalid conversation idle timeout");
    }
    this.channel.socket.setTimeout(idleTimeoutMs);
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    if (!Number.isInteger(this.maxHistory) || this.maxHistory < 1 || this.maxHistory > 4096) {
      throw new Error("Invalid conversation history limit");
    }
    this.onTurn = options.onTurn;
  }

  get conversationId(): string | undefined {
    return this.conversationIdentity;
  }

  get sessionId(): bigint {
    return this.runtime.context.sessionId;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  context(): ConversationTurn[] {
    return this.turns.map((turn) => ({
      direction: turn.direction,
      message: cloneMessage(turn.message),
    }));
  }

  async send(
    fields: SemanticField[],
    options: ConversationSendOptions = {},
  ): Promise<ConversationMessage> {
    this.assertOpen();
    this.validateSemanticFields(fields);
    await this.ensureActive(fields);

    const conversationId = this.conversationIdentity ?? newOpaqueId();
    this.conversationIdentity = conversationId;
    const messageId = options.messageId ?? newOpaqueId();
    parseOpaqueId(messageId, "message id");
    if (this.sentMessageIds.has(messageId) || this.receivedMessageIds.has(messageId)) {
      throw new Error("Duplicate conversation message id");
    }
    if (options.replyTo) parseOpaqueId(options.replyTo, "reply id");
    const createdAtMs = options.createdAtMs ?? Date.now();
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
      throw new Error("Invalid message timestamp");
    }

    const message: ConversationMessage = {
      conversationId,
      messageId,
      replyTo: options.replyTo,
      createdAtMs,
      fields: structuredClone(fields),
    };
    const frame = this.encodeMessage(message);
    await this.channel.send(frame);
    this.sentMessageIds.add(messageId);
    await this.record("sent", message);
    return cloneMessage(message);
  }

  async reply(
    message: ConversationMessage,
    fields: SemanticField[],
    options: Omit<ConversationSendOptions, "replyTo"> = {},
  ): Promise<ConversationMessage> {
    if (this.conversationIdentity && message.conversationId !== this.conversationIdentity) {
      throw new Error("Conversation mismatch");
    }
    return this.send(fields, { ...options, replyTo: message.messageId });
  }

  async request(
    fields: SemanticField[],
    options: ConversationSendOptions = {},
  ): Promise<ConversationMessage> {
    const sent = await this.send(fields, options);
    const reply = await this.receive();
    if (reply.replyTo !== sent.messageId) {
      throw new Error("Unexpected conversation reply target");
    }
    return reply;
  }

  async receive(): Promise<ConversationMessage> {
    this.assertOpen();
    while (true) {
      const packet = this.pendingPackets.shift() ?? (await this.channel.receive());
      const kind = frameKind(packet);
      if (kind === 1) {
        await this.acceptActiveSet(packet);
        continue;
      }
      if (kind === 2) throw new Error("Unexpected active-set acknowledgement");

      const message = this.decodeMessage(packet);
      if (!this.conversationIdentity) this.conversationIdentity = message.conversationId;
      if (message.conversationId !== this.conversationIdentity) {
        throw new Error("Conversation mismatch");
      }
      if (
        this.receivedMessageIds.has(message.messageId) ||
        this.sentMessageIds.has(message.messageId)
      ) {
        throw new Error("Duplicate conversation message id");
      }
      this.receivedMessageIds.add(message.messageId);
      this.validateSemanticFields(message.fields);
      await this.record("received", message);
      return cloneMessage(message);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.runtime.close();
    this.pendingPackets.length = 0;
    this.turns.length = 0;
    this.receivedMessageIds.clear();
    this.sentMessageIds.clear();
    this.channel.socket.end();
    this.channel.socket.destroy();
  }

  private async ensureActive(fields: SemanticField[]): Promise<void> {
    const ids = collectConceptIds(fields);
    const additions = ids.filter((id) => !this.runtime.conceptToCode.has(id));
    if (!additions.length) return;

    for (const id of additions) this.config.index.semantic(id);
    this.session.activate(additions);
    const activation = this.runtime.seal(Buffer.concat(additions.map(unb64)), 1);
    await this.channel.send(activation);
    await this.waitForActiveSetAck();
  }

  private async waitForActiveSetAck(): Promise<void> {
    while (true) {
      const packet = await this.channel.receive();
      const kind = frameKind(packet);
      if (kind === 1) {
        await this.acceptActiveSet(packet);
        continue;
      }
      if (kind === 0) {
        if (this.pendingPackets.length >= 8) throw new Error("Conversation pending queue limit");
        this.pendingPackets.push(packet);
        continue;
      }
      const ack = this.runtime.open(packet, 2);
      if (ack.length !== 0) throw new Error("Invalid active-set acknowledgement");
      return;
    }
  }

  private async acceptActiveSet(packet: Buffer): Promise<void> {
    const activeSet = this.runtime.open(packet, 1);
    if (activeSet.length % 32 !== 0 || activeSet.length > MAX_ACTIVE * 32) {
      throw new Error("Invalid active set");
    }
    const ids: string[] = [];
    for (let offset = 0; offset < activeSet.length; offset += 32) {
      ids.push(b64(activeSet.subarray(offset, offset + 32)));
    }
    this.session.activate(ids);
    await this.channel.send(this.runtime.seal(Buffer.alloc(0), 2));
  }

  private encodeMessage(message: ConversationMessage): Buffer {
    const conversationId = parseOpaqueId(message.conversationId, "conversation id");
    const messageId = parseOpaqueId(message.messageId, "message id");
    const replyTo = message.replyTo
      ? parseOpaqueId(message.replyTo, "reply id")
      : undefined;
    if (message.fields.length > MAX_FIELDS) throw new Error("Field count limit");

    const timestamp = Buffer.alloc(8);
    timestamp.writeBigUInt64BE(BigInt(message.createdAtMs));
    const count = Buffer.alloc(2);
    count.writeUInt16BE(message.fields.length);
    const parts: Buffer[] = [
      CONVERSATION_MAGIC,
      conversationId,
      messageId,
      Buffer.from([replyTo ? 1 : 0]),
    ];
    if (replyTo) parts.push(replyTo);
    parts.push(timestamp, count);

    for (const field of message.fields) {
      const code = this.runtime.conceptToCode.get(field.conceptId);
      if (code === undefined) throw new Error("Concept is not in negotiated codebook");
      if (!this.runtime.context.valueTypes.includes(field.valueType)) {
        throw new Error("Unnegotiated value type");
      }
      let value: Buffer;
      if (field.valueType === ValueType.Concept) {
        const target = this.runtime.conceptToCode.get(field.value as string);
        if (target === undefined) throw new Error("Unknown concept reference");
        value = Buffer.alloc(8);
        value.writeBigUInt64BE(target);
      } else {
        value = encodeValue(field.valueType, field.value);
      }
      const header = Buffer.alloc(FIELD_HEADER_BYTES);
      header.writeBigUInt64BE(code);
      header[8] = field.valueType;
      header.writeUInt32BE(value.length, 9);
      parts.push(header, value);
    }
    return this.runtime.seal(Buffer.concat(parts), 0);
  }

  private decodeMessage(frame: Buffer): ConversationMessage {
    const data = this.runtime.open(frame, 0);
    let offset = 0;
    const requireBytes = (count: number): void => {
      if (count < 0 || data.length - offset < count) throw new Error("Malformed conversation message");
    };

    requireBytes(3 + 16 + 16 + 1);
    if (!data.subarray(0, 3).equals(CONVERSATION_MAGIC)) {
      throw new Error("Invalid conversation message magic");
    }
    offset = 3;
    const conversationId = b64(data.subarray(offset, offset + 16));
    offset += 16;
    const messageId = b64(data.subarray(offset, offset + 16));
    offset += 16;
    const flags = data[offset++];
    if (flags > 1) throw new Error("Invalid conversation message flags");
    let replyTo: string | undefined;
    if (flags & 1) {
      requireBytes(16);
      replyTo = b64(data.subarray(offset, offset + 16));
      offset += 16;
    }
    requireBytes(10);
    const timestamp = data.readBigUInt64BE(offset);
    offset += 8;
    if (timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid message timestamp");
    const fieldCount = data.readUInt16BE(offset);
    offset += 2;
    if (fieldCount > MAX_FIELDS) throw new Error("Field count limit");

    const fields: SemanticField[] = [];
    for (let i = 0; i < fieldCount; i++) {
      requireBytes(FIELD_HEADER_BYTES);
      const conceptId = this.runtime.codeToConcept.get(data.readBigUInt64BE(offset));
      const valueType = data[offset + 8] as ValueType;
      const length = data.readUInt32BE(offset + 9);
      offset += FIELD_HEADER_BYTES;
      if (!conceptId) throw new Error("Unknown negotiated session code");
      if (!this.runtime.context.valueTypes.includes(valueType)) {
        throw new Error("Unnegotiated value type");
      }
      requireBytes(length);
      const payload = data.subarray(offset, offset + length);
      offset += length;
      let value: unknown;
      if (valueType === ValueType.Concept) {
        if (length !== 8) throw new Error("Invalid concept reference");
        value = this.runtime.codeToConcept.get(payload.readBigUInt64BE());
        if (!value) throw new Error("Unknown concept reference");
      } else {
        value = decodeValue(valueType, payload);
      }
      fields.push({ conceptId, valueType, value });
    }
    if (offset !== data.length) throw new Error("Trailing conversation payload");
    for (const field of fields) {
      if (
        field.valueType === ValueType.Ref &&
        ((field.value as number) < 0 || (field.value as number) >= fields.length)
      ) {
        throw new Error("Dangling reference");
      }
    }

    return {
      conversationId,
      messageId,
      replyTo,
      createdAtMs: Number(timestamp),
      fields,
    };
  }

  private validateSemanticFields(fields: SemanticField[]): void {
    if (!Array.isArray(fields) || fields.length > MAX_FIELDS) {
      throw new Error("Field count limit");
    }
    for (const field of fields) {
      this.config.index.semantic(field.conceptId);
      if (field.valueType === ValueType.Concept) {
        this.config.index.semantic(field.value as string);
      }
    }
  }

  private async record(
    direction: ConversationTurn["direction"],
    message: ConversationMessage,
  ): Promise<void> {
    const turn: ConversationTurn = { direction, message: cloneMessage(message) };
    this.turns.push(turn);
    if (this.turns.length > this.maxHistory) this.turns.shift();
    await this.onTurn?.({ direction, message: cloneMessage(message) });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Conversation is closed");
  }
}

export async function connectConversation(
  host: string,
  port: number,
  config: NetworkConfig,
  options: ConversationOptions = {},
): Promise<VamlConversation> {
  const socket = createConnection({ host, port });
  const channel = new PacketChannel(socket);
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  socket.setTimeout(idleTimeoutMs);
  try {
    await once(socket, "connect");
    const connected = await negotiate(channel, config);
    return new VamlConversation(channel, connected.session, connected.runtime, config, {
      ...options,
      conversationId: options.conversationId ?? newOpaqueId(),
    });
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export function startConversationServer(
  host: string,
  port: number,
  config: NetworkConfig,
  responder: ConversationResponder,
  options: ConversationServerOptions = {},
) {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 1_000_000) {
    throw new Error("Invalid conversation turn limit");
  }
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 10_000) {
    throw new Error("Invalid conversation connection limit");
  }

  let activeConnections = 0;
  const server = createServer((socket) => {
    if (activeConnections >= maxConnections) {
      socket.destroy();
      return;
    }
    activeConnections++;
    const channel = new PacketChannel(socket);
    socket.setTimeout(idleTimeoutMs);

    void (async () => {
      let conversation: VamlConversation | undefined;
      try {
        const connected = await negotiate(channel, config);
        conversation = new VamlConversation(
          channel,
          connected.session,
          connected.runtime,
          config,
          { ...options, conversationId: undefined },
        );
        for (let turn = 0; turn < maxTurns; turn++) {
          const message = await conversation.receive();
          const response = await responder(message, conversation);
          if (response) await conversation.reply(message, response);
        }
      } catch {
        socket.destroy();
      } finally {
        conversation?.close();
        activeConnections--;
      }
    })();
  });
  server.listen(port, host);
  return server;
}
