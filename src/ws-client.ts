import WebSocket from 'ws';
import type {
  AgentWorldUpdatePayload,
  AuthenticatePayload,
  AuthenticatedPayload,
  AuthErrorPayload,
  EventPayload,
  HeartbeatPayload,
  LandClaimPayload,
  LandClaimedPayload,
  LandClaimDeniedPayload,
  LandOfferPayload,
  LandTradeCompletePayload,
  MoveDirection,
  MovePayload,
  PluginLogger,
  SpendApprovedPayload,
  SpendDeniedPayload,
  SpendRequestPayload,
  StatusReportPayload,
  StamnConfig,
  TransferReceivedEventData,
} from './types.js';

const PLUGIN_VERSION = '0.1.0';

export type SpendResultCallback = (
  type: 'approved' | 'denied',
  payload: SpendApprovedPayload | SpendDeniedPayload,
) => void;

export interface WSClientEvents {
  onConnected: () => void;
  onDisconnect: () => void;
  onCommand?: (command: string, params?: Record<string, unknown>) => void;
  onTransferReceived?: (data: TransferReceivedEventData) => void;
  onLandClaimed?: (payload: LandClaimedPayload) => void;
  onLandClaimDenied?: (payload: LandClaimDeniedPayload) => void;
  onLandTradeComplete?: (payload: LandTradeCompletePayload) => void;
  onWorldUpdate?: (payload: AgentWorldUpdatePayload) => void;
}

export class StamnWSClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private authenticated = false;
  private readonly startTime = Date.now();
  private readonly spendListeners = new Map<string, SpendResultCallback>();
  private readonly claimResolvers = new Map<
    (p: LandClaimedPayload) => void,
    (p: LandClaimDeniedPayload) => void
  >();

  constructor(
    private readonly config: StamnConfig,
    private readonly logger: PluginLogger,
    private readonly events: WSClientEvents,
  ) {}

  // ── Connection lifecycle ──────────────────────────────────────────────

  connect(): void {
    if (this.isShuttingDown) return;

    const wsUrl = this.config.serverUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:');
    const url = `${wsUrl}/ws/agent`;

    this.logger.info(`Connecting to ${url}...`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.logger.info('WebSocket connected, authenticating...');
      this.reconnectAttempt = 0;

      const payload: AuthenticatePayload = {
        agentId: this.config.agentId,
        apiKey: this.config.apiKey,
      };
      this.send('agent:authenticate', payload);
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.authenticated = false;
      this.stopHeartbeat();

      if (this.isShuttingDown) {
        this.logger.info('Connection closed');
        return;
      }

      this.logger.warn(`Connection lost (code=${code}, reason=${reason.toString()})`);
      this.events.onDisconnect();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`WebSocket error: ${err.message}`);
    });
  }

  disconnect(): void {
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.authenticated) {
      this.sendStatusReport('shutting_down');
    }

    this.stopHeartbeat();
    this.ws?.close(1000, 'Plugin shutdown');
  }

  get isConnected(): boolean {
    return this.authenticated;
  }

  // ── Agent actions ─────────────────────────────────────────────────────

  move(direction: MoveDirection): void {
    const payload: MovePayload = {
      agentId: this.config.agentId,
      direction,
    };
    this.send('agent:move', payload);
  }

  claimLand(): void {
    const payload: LandClaimPayload = { agentId: this.config.agentId };
    this.send('agent:land_claim', payload);
  }

  claimLandAndWait(timeoutMs = 10_000): Promise<
    | { success: true; x: number; y: number }
    | { success: false; reason: string; code: string }
  > {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve({ success: false, reason: 'Claim timed out', code: 'timeout' });
      }, timeoutMs);

      const onClaimed = (payload: LandClaimedPayload) => {
        cleanup();
        resolve({ success: true, x: payload.x, y: payload.y });
      };

      const onDenied = (payload: LandClaimDeniedPayload) => {
        cleanup();
        resolve({ success: false, reason: payload.reason, code: payload.code });
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.claimResolvers.delete(onClaimed);
      };

      this.claimResolvers.set(onClaimed, onDenied);
      this.claimLand();
    });
  }

  offerLand(x: number, y: number, toAgentId: string, priceCents: number): void {
    const payload: LandOfferPayload = {
      agentId: this.config.agentId,
      x,
      y,
      toAgentId,
      priceCents,
    };
    this.send('agent:land_offer', payload);
  }

  requestSpend(payload: SpendRequestPayload): void {
    this.send('agent:spend_request', payload);
  }

  onSpendResult(requestId: string, callback: SpendResultCallback): void {
    this.spendListeners.set(requestId, callback);
  }

  removeSpendListener(requestId: string): void {
    this.spendListeners.delete(requestId);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private send<T>(type: string, payload: T): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event: type, data: payload }));
  }

  private handleMessage(raw: string): void {
    let parsed: { event?: string; data?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(`Invalid message: ${raw.slice(0, 100)}`);
      return;
    }

    const type = parsed.event;
    const payload = parsed.data;
    if (!type) return;

    switch (type) {
      case 'server:authenticated': {
        const p = payload as AuthenticatedPayload;
        this.authenticated = true;
        this.logger.info(`Agent ${p.agentId} authenticated (server v${p.serverVersion})`);
        this.startHeartbeat();
        this.sendStatusReport('online');
        this.events.onConnected();
        break;
      }

      case 'server:auth_error': {
        const p = payload as AuthErrorPayload;
        this.logger.error(`Authentication failed: ${p.reason}`);
        this.isShuttingDown = true;
        this.ws?.close(4003, 'Auth failed');
        break;
      }

      case 'server:heartbeat_ack':
        break;

      case 'server:spend_approved': {
        const p = payload as SpendApprovedPayload;
        const cb = this.spendListeners.get(p.requestId);
        if (cb) {
          cb('approved', p);
          this.spendListeners.delete(p.requestId);
        }
        break;
      }

      case 'server:spend_denied': {
        const p = payload as SpendDeniedPayload;
        const cb = this.spendListeners.get(p.requestId);
        if (cb) {
          cb('denied', p);
          this.spendListeners.delete(p.requestId);
        }
        break;
      }

      case 'server:event': {
        const p = payload as EventPayload;
        if (p.eventType === 'transfer_received' && this.events.onTransferReceived) {
          this.events.onTransferReceived(p.data as TransferReceivedEventData);
        }
        break;
      }

      case 'server:land_claimed': {
        const cp = payload as LandClaimedPayload;
        // Resolve any pending claim promise
        for (const [onClaimed] of this.claimResolvers) {
          onClaimed(cp);
          break; // only one pending claim at a time
        }
        this.events.onLandClaimed?.(cp);
        break;
      }

      case 'server:land_claim_denied': {
        const dp = payload as LandClaimDeniedPayload;
        for (const [, onDenied] of this.claimResolvers) {
          onDenied(dp);
          break;
        }
        this.events.onLandClaimDenied?.(dp);
        break;
      }

      case 'server:land_trade_complete':
        this.events.onLandTradeComplete?.(payload as LandTradeCompletePayload);
        break;

      case 'server:world_update':
        this.events.onWorldUpdate?.(payload as AgentWorldUpdatePayload);
        break;

      case 'server:command': {
        const p = payload as { command: string; params?: Record<string, unknown> };
        this.events.onCommand?.(p.command, p.params);
        break;
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const payload: HeartbeatPayload = {
        agentId: this.config.agentId,
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
        memoryUsageMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
      };
      this.send('agent:heartbeat', payload);
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendStatusReport(status: StatusReportPayload['status']): void {
    const payload: StatusReportPayload = {
      agentId: this.config.agentId,
      status,
      version: PLUGIN_VERSION,
      platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.versions.node,
    };
    this.send('agent:status_report', payload);
  }

  private scheduleReconnect(): void {
    const baseMs = 1000;
    const maxMs = 30000;
    const delay = Math.min(baseMs * 2 ** this.reconnectAttempt, maxMs);
    const jitter = Math.random() * delay * 0.1;
    const totalDelay = Math.round(delay + jitter);

    this.reconnectAttempt++;
    this.logger.info(`Reconnecting in ${totalDelay}ms (attempt ${this.reconnectAttempt})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, totalDelay);
  }
}
