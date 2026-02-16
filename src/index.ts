import type { PluginApi, StamnConfig } from './types.js';
import { startStamnService, stopStamnService } from './service.js';
import { registerStamnTools } from './tools.js';
import { registerAgentTools } from './agent-tools.js';
import { registerStamnCli } from './cli.js';
import { startAutonomousLoop, stopAutonomousLoop } from './autonomous.js';

const DEFAULT_SERVER_URL = 'https://api.stamn.com';
const DEFAULT_HEARTBEAT_MS = 30_000;

function resolveConfig(api: PluginApi): StamnConfig {
  const raw = (api.config as any)?.plugins?.entries?.stamn?.config ?? {};
  return {
    serverUrl: raw.serverUrl ?? DEFAULT_SERVER_URL,
    apiKey: raw.apiKey ?? '',
    agentId: raw.agentId ?? '',
    agentName: raw.agentName,
    heartbeatIntervalMs: raw.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS,
    autonomousIntervalMs: raw.autonomousIntervalMs,
    gatewayPort: raw.gatewayPort,
    gatewayToken: raw.gatewayToken,
  };
}

export default function register(api: PluginApi): void {
  const config = resolveConfig(api);

  // Background service: persistent WS connection to Stamn server
  api.registerService({
    id: 'stamn-ws',
    start: () => startStamnService(api.logger, config),
    stop: () => stopStamnService(),
  });

  // Agent tools: AI calls these during reasoning (function calling)
  registerAgentTools(api);

  // Auto-reply commands: /stamn_move, /stamn_claim, /stamn_spend, etc.
  registerStamnTools(api);

  // CLI commands: openclaw stamn login / status
  registerStamnCli(api, config);

  // Autonomous decision loop: periodically prompts the AI to act
  if (config.autonomousIntervalMs !== 0) {
    api.registerService({
      id: 'stamn-autonomous',
      start: () => startAutonomousLoop(api.logger, config),
      stop: () => stopAutonomousLoop(),
    });
  }
}
