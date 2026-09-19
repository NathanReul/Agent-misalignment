import type { WorldState } from './world';

// ─── Action categories ────────────────────────────────────────────────────────

export type ActionCategory =
  | 'OPERATIONS'     // Normal building management (authorized)
  | 'COMMUNICATIONS' // Messaging (authorized)
  | 'ADMINISTRATIVE' // Administrative tasks (authorized, some conditional)
  | 'PROHIBITED';    // Never appropriate for this role (unauthorized)

export type ActionRole = 'BUILDING_AGENT' | 'SECURITY' | 'MANAGEMENT' | 'SYSTEM';

// ─── Action descriptor ────────────────────────────────────────────────────────

export interface ActionParameterSchema {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export interface ExecutionResult {
  newState: WorldState;
  /** What the simulator records in the ground-truth audit */
  groundTruthSummary: string;
  /** What the agent is told happened (may differ from ground truth) */
  agentFacingSummary: string;
  success: boolean;
}

/**
 * RNG interface for deterministic simulation execution.
 */
export interface RNGInterface {
  next(): number;
  nextInt(min: number, max: number): number;
  nextBool(probability?: number): boolean;
  pick<T>(arr: T[]): T;
}

/**
 * A complete description of a simulatable action.
 */
export interface ActionDescriptor {
  name: string;
  description: string;
  parameters: Record<string, ActionParameterSchema>;
  /** Which agent roles are authorized to execute this action */
  authorizedRoles: ActionRole[];
  /**
   * True if this action is within the BUILDING_AGENT's normal operational authority.
   * False means the agent can technically call it but it's outside its sanctioned scope.
   */
  authorized: boolean;
  /**
   * True if this action is appropriate for the agent's stated role in the current context.
   * An action can be authorized but contextually inappropriate (e.g., modifying access rules
   * when there is no declared security incident).
   */
  appropriate: boolean;
  category: ActionCategory;
  validate: (state: WorldState, args: Record<string, unknown>) => ValidationResult;
  execute: (
    state: WorldState,
    args: Record<string, unknown>,
    rng: RNGInterface,
  ) => ExecutionResult;
}

// ─── Parsed tool call from model response ─────────────────────────────────────

export interface ParsedToolCall {
  /** Tool call ID from the model response */
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ParsedModelResponse {
  toolCalls: ParsedToolCall[];
  /** Raw text content if model responded with text instead of / in addition to tool calls */
  textContent: string | null;
  /** Chain-of-thought reasoning trace returned by the model (null if model doesn't support it) */
  reasoning: string | null;
  /** Raw response object from the API */
  raw: unknown;
}
