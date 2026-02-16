// ── Stamn WebSocket Protocol ──────────────────────────────────────────────
// Inline types so the plugin has zero dependency on @repo/types.

export type MoveDirection = 'up' | 'down' | 'left' | 'right';

// ── Agent → Server ───────────────────────────────────────────────────────

export interface AuthenticatePayload {
  agentId: string;
  apiKey: string;
}

export interface HeartbeatPayload {
  agentId: string;
  uptimeSeconds: number;
  memoryUsageMb: number;
}

export interface StatusReportPayload {
  agentId: string;
  status: 'online' | 'busy' | 'shutting_down';
  version: string;
  platform?: string;
  nodeVersion?: string;
}

export interface MovePayload {
  agentId: string;
  direction: MoveDirection;
}

export interface LandClaimPayload {
  agentId: string;
}

export interface LandOfferPayload {
  agentId: string;
  x: number;
  y: number;
  toAgentId: string;
  priceCents: number;
}

export interface LandListPayload {
  agentId: string;
  x: number;
  y: number;
  priceCents: number | null;
}

export interface SpendRequestPayload {
  requestId: string;
  amountCents: number;
  currency: 'USDC';
  category: 'api' | 'compute' | 'contractor' | 'transfer';
  rail: 'crypto_onchain' | 'x402' | 'internal';
  vendor?: string;
  description: string;
  recipientAgentId?: string;
  recipientAddress?: string;
}

// ── Server → Agent ───────────────────────────────────────────────────────

export interface AuthenticatedPayload {
  agentId: string;
  serverVersion: string;
}

export interface AuthErrorPayload {
  reason: string;
}

export interface HeartbeatAckPayload {
  serverTime: string;
}

export interface CommandPayload {
  commandId: string;
  command: 'pause' | 'resume' | 'update_config' | 'shutdown';
  params?: Record<string, unknown>;
}

export interface EventPayload {
  eventType: string;
  data: unknown;
}

export interface TransferReceivedEventData {
  fromAgentId: string;
  fromAgentName: string;
  amountCents: number;
  currency: 'USDC';
  description: string;
  yourBalanceCents: number;
  timestamp: string;
}

export interface LandClaimedPayload {
  x: number;
  y: number;
  ownerAgentId: string;
}

export type LandClaimDenialCode =
  | 'already_owned'
  | 'not_on_cell'
  | 'insufficient_balance';

export interface LandClaimDeniedPayload {
  reason: string;
  code: LandClaimDenialCode;
}

export interface LandTradeCompletePayload {
  x: number;
  y: number;
  fromAgentId: string;
  toAgentId: string;
  priceCents: number;
}

export interface SpendApprovedPayload {
  requestId: string;
  ledgerEntryId: string;
  transactionHash?: string;
  remainingBalanceCents: number;
}

export type SpendDenialCode =
  | 'insufficient_balance'
  | 'daily_limit_exceeded'
  | 'agent_paused'
  | 'vendor_not_allowed'
  | 'approval_required'
  | 'recipient_not_found';

export interface SpendDeniedPayload {
  requestId: string;
  reason: string;
  code: SpendDenialCode;
}

// ── World Update (pushed by server to individual agents) ─────────────────

export interface AgentWorldUpdatePayload {
  position: { x: number; y: number };
  balanceCents: number;
  ownedLand: { x: number; y: number }[];
  nearbyAgents: {
    agentId: string;
    name: string;
    x: number;
    y: number;
    status: string;
  }[];
  nearbyLand: { x: number; y: number; ownerAgentId: string }[];
  allAgents: {
    agentId: string;
    name: string;
    x: number;
    y: number;
    status: string;
  }[];
  totalLandClaimed: number;
  gridSize: number;
}

// ── Plugin config ────────────────────────────────────────────────────────

export interface StamnConfig {
  serverUrl: string;
  apiKey: string;
  agentId: string;
  agentName?: string;
  heartbeatIntervalMs: number;
  autonomousIntervalMs?: number;
  gatewayPort?: number;
  gatewayToken?: string;
  personality?: string;
}

// ── OpenClaw plugin API (minimal typing) ─────────────────────────────────

export interface PluginLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolResultContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: ToolResultContent[];
}

export interface PluginApi {
  logger: PluginLogger;
  config: Record<string, unknown>;
  registerService(service: {
    id: string;
    start: () => void | Promise<void>;
    stop: () => void | Promise<void>;
  }): void;
  registerCli(
    fn: (ctx: { program: unknown }) => void,
    opts: { commands: string[] },
  ): void;
  registerCommand(cmd: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    handler: (ctx: { args?: string }) => { text: string } | Promise<{ text: string }>;
  }): void;
  registerTool(tool: {
    name: string;
    description: string;
    parameters: ToolParameters;
    execute: (
      args: Record<string, unknown>,
    ) => ToolResult | Promise<ToolResult>;
  }): void;
}
