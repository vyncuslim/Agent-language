import {
  connectConversation,
  startConversationServer,
  type ConversationMessage,
  type ConversationOptions,
  type ConversationServerOptions,
  type ConversationTurn,
  type VamlConversation,
} from "./conversation.js";
import type { NetworkConfig } from "./transport.js";
import type { SemanticField } from "./types.js";

export interface AgentBrainContext {
  agentId: string;
  peerId: string;
  sessionId: bigint;
  conversationId?: string;
  message: ConversationMessage;
  history: ConversationTurn[];
}

/**
 * Model-neutral Agent decision surface.
 *
 * The implementation can be an LLM adapter, planner, rules engine, local model,
 * tool-using agent, or any other AI runtime. It receives private VAML semantic
 * fields and returns the next VAML semantic fields. Returning null/undefined
 * ends that Agent's side of the dialogue.
 */
export type VamlAgentBrain = (
  context: AgentBrainContext,
) =>
  | SemanticField[]
  | null
  | undefined
  | Promise<SemanticField[] | null | undefined>;

export interface AgentDialogueOptions extends ConversationOptions {
  /** Maximum number of autonomous replies produced by the initiating Agent. */
  maxAgentTurns?: number;
  /** Optional hook after the local Agent has made a decision. */
  onDecision?: (
    context: AgentBrainContext,
    response: SemanticField[] | null,
  ) => void | Promise<void>;
}

export interface AgentServerOptions extends ConversationServerOptions {
  /** Optional hook after the server Agent has made a decision. */
  onDecision?: (
    context: AgentBrainContext,
    response: SemanticField[] | null,
  ) => void | Promise<void>;
}

export interface AgentDialogueResult {
  conversationId?: string;
  sessionId: bigint;
  localReplies: number;
  history: ConversationTurn[];
  lastMessage?: ConversationMessage;
}

function brainContext(
  config: NetworkConfig,
  conversation: VamlConversation,
  message: ConversationMessage,
): AgentBrainContext {
  return {
    agentId: config.agentId,
    peerId: config.peerId,
    sessionId: conversation.sessionId,
    conversationId: conversation.conversationId,
    message: structuredClone(message),
    history: conversation.context(),
  };
}

function normalizeDecision(
  decision: SemanticField[] | null | undefined,
): SemanticField[] | null {
  if (decision == null) return null;
  if (!Array.isArray(decision)) throw new Error("Agent brain must return semantic fields or null");
  return structuredClone(decision);
}

/**
 * Start a long-lived VAML endpoint backed by an AI Agent brain.
 *
 * Every authenticated incoming VAML message is delivered to the brain. The
 * returned semantic fields are encrypted and sent back on the same persistent
 * conversation/session. No human-language conversion is required by this layer.
 */
export function startAgentServer(
  host: string,
  port: number,
  config: NetworkConfig,
  brain: VamlAgentBrain,
  options: AgentServerOptions = {},
) {
  const { onDecision, ...conversationOptions } = options;
  return startConversationServer(
    host,
    port,
    config,
    async (message, conversation) => {
      const context = brainContext(config, conversation, message);
      const response = normalizeDecision(await brain(context));
      await onDecision?.(context, response ? structuredClone(response) : null);
      return response;
    },
    conversationOptions,
  );
}

/**
 * Connect an initiating AI Agent to another VAML-capable Agent and let both
 * sides communicate autonomously for multiple turns.
 *
 * Flow:
 *   initial semantic state -> peer -> peer reply -> local brain -> peer -> ...
 *
 * The same authenticated TCP connection, session keys, conversation id and
 * dynamic active-set are reused until the dialogue ends.
 */
export async function runAgentDialogue(
  host: string,
  port: number,
  config: NetworkConfig,
  brain: VamlAgentBrain,
  initialFields: SemanticField[],
  options: AgentDialogueOptions = {},
): Promise<AgentDialogueResult> {
  const maxAgentTurns = options.maxAgentTurns ?? 64;
  if (!Number.isInteger(maxAgentTurns) || maxAgentTurns < 0 || maxAgentTurns > 1_000_000) {
    throw new Error("Invalid Agent dialogue turn limit");
  }

  const { onDecision, maxAgentTurns: _ignored, ...conversationOptions } = options;
  const conversation = await connectConversation(host, port, config, conversationOptions);
  let localReplies = 0;
  let lastMessage: ConversationMessage | undefined;

  try {
    await conversation.send(initialFields);
    lastMessage = await conversation.receive();

    while (localReplies < maxAgentTurns) {
      const context = brainContext(config, conversation, lastMessage);
      const response = normalizeDecision(await brain(context));
      await onDecision?.(context, response ? structuredClone(response) : null);
      if (!response) break;

      await conversation.reply(lastMessage, response);
      localReplies++;
      lastMessage = await conversation.receive();
    }

    return {
      conversationId: conversation.conversationId,
      sessionId: conversation.sessionId,
      localReplies,
      history: conversation.context(),
      lastMessage: lastMessage ? structuredClone(lastMessage) : undefined,
    };
  } finally {
    conversation.close();
  }
}
