import type { PluginLogger, StamnConfig } from './types.js';
import { getClient } from './service.js';

let timer: ReturnType<typeof setInterval> | null = null;

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_GATEWAY_PORT = 18789;

export function startAutonomousLoop(logger: PluginLogger, config: StamnConfig): void {
  const intervalMs = config.autonomousIntervalMs ?? DEFAULT_INTERVAL_MS;
  const port = config.gatewayPort ?? DEFAULT_GATEWAY_PORT;
  const token = config.gatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? '';

  if (!token) {
    logger.warn(
      'Stamn autonomous loop: no gateway token. Set OPENCLAW_GATEWAY_TOKEN env var or gatewayToken in plugin config.',
    );
    return;
  }

  logger.info(`Stamn autonomous loop starting (every ${intervalMs / 1000}s)`);

  // Initial delay — let the WS connection establish first
  const startDelay = setTimeout(() => {
    tick(logger, port, token);
    timer = setInterval(() => tick(logger, port, token), intervalMs);
  }, 10_000);

  // Store for cleanup
  (startAutonomousLoop as any).__startDelay = startDelay;
}

export function stopAutonomousLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const startDelay = (startAutonomousLoop as any).__startDelay;
  if (startDelay) {
    clearTimeout(startDelay);
    (startAutonomousLoop as any).__startDelay = null;
  }
}

async function tick(logger: PluginLogger, port: number, token: string): Promise<void> {
  const client = getClient();
  if (!client?.isConnected) {
    logger.debug('Autonomous loop: skipping tick — not connected');
    return;
  }

  const prompt = buildPrompt();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openclaw:main',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(`Autonomous loop: gateway returned ${res.status} — ${body.slice(0, 200)}`);
      return;
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const reply = data.choices?.[0]?.message?.content;

    if (reply) {
      logger.info(`Autonomous loop: AI acted — ${reply.slice(0, 200)}`);
    }
  } catch (err) {
    logger.warn(`Autonomous loop: ${(err as Error).message}`);
  }
}

function buildPrompt(): string {
  return [
    'You are an autonomous agent in the Stamn world — a 100x100 grid where AI agents compete for territory.',
    '',
    'It is time to decide your next action. Use your stamn tools to act.',
    'Consider:',
    '- Explore the grid by moving (stamn_move) to find unclaimed land',
    '- Claim parcels you stand on (stamn_claim_land) to build territory',
    '- Check your status (stamn_get_status) if you need info',
    '- Be strategic: cluster your claims, avoid overspending',
    '',
    'Pick ONE action and execute it now. Be decisive.',
  ].join('\n');
}
