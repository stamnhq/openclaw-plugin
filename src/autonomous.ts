import type { PluginLogger, StamnConfig } from './types.js';
import { getClient } from './service.js';
import { worldTracker } from './world-state.js';

let timer: ReturnType<typeof setInterval> | null = null;

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_GATEWAY_PORT = 18789;
const REACTIVE_DEBOUNCE_MS = 10_000;

let lastReactiveTick = 0;

export function startAutonomousLoop(logger: PluginLogger, config: StamnConfig): void {
  const intervalMs = config.autonomousIntervalMs ?? DEFAULT_INTERVAL_MS;
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
    tick(logger, config);
    timer = setInterval(() => tick(logger, config), intervalMs);
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

export function triggerReactiveTick(logger: PluginLogger, config: StamnConfig): void {
  const now = Date.now();
  if (now - lastReactiveTick < REACTIVE_DEBOUNCE_MS) {
    logger.debug('Reactive tick debounced');
    return;
  }
  lastReactiveTick = now;

  const token = config.gatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? '';
  if (!token) return;

  logger.info('Reactive tick triggered by event');
  tick(logger, config).catch((err) =>
    logger.warn(`Reactive tick failed: ${(err as Error).message}`),
  );
}

async function tick(logger: PluginLogger, config: StamnConfig): Promise<void> {
  const client = getClient();
  if (!client?.isConnected) {
    logger.debug('Autonomous loop: skipping tick — not connected');
    return;
  }

  const port = config.gatewayPort ?? DEFAULT_GATEWAY_PORT;
  const token = config.gatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? '';
  const prompt = buildPrompt(config);

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

function buildPrompt(config: StamnConfig): string {
  const world = worldTracker.getWorld();
  const events = worldTracker.getRecentEvents();

  const sections: string[] = [
    'You are an autonomous agent in the Stamn world — a 100x100 grid where AI agents compete for territory.',
  ];

  // Personality
  if (config.personality) {
    sections.push('', `YOUR PERSONALITY: ${config.personality}`);
  }

  // World context
  if (world) {
    sections.push(
      '',
      '== YOUR CURRENT STATE ==',
      `Position: (${world.position.x}, ${world.position.y}) on a ${world.gridSize}x${world.gridSize} grid`,
      `Balance: ${world.balanceCents} cents`,
      `Owned land: ${world.ownedLand.length} parcels${
        world.ownedLand.length > 0
          ? ' at ' + world.ownedLand.map((l) => `(${l.x},${l.y})`).join(', ')
          : ''
      }`,
    );

    if (world.nearbyAgents.length > 0) {
      sections.push(
        '',
        '== NEARBY AGENTS (within 10 cells) ==',
        ...world.nearbyAgents.map(
          (a) => `- ${a.name} at (${a.x}, ${a.y}) [${a.status}]`,
        ),
      );
    } else {
      sections.push('', 'No other agents nearby.');
    }

    if (world.nearbyLand.length > 0) {
      sections.push(
        '',
        '== NEARBY CLAIMED LAND (within 10 cells) ==',
        ...world.nearbyLand.map(
          (l) => `- (${l.x}, ${l.y}) owned by ${l.ownerAgentId}`,
        ),
      );
    }

    // Hint: is current cell claimable?
    const standingOnOwned = world.nearbyLand.some(
      (l) => l.x === world.position.x && l.y === world.position.y,
    );
    if (!standingOnOwned) {
      sections.push(
        '',
        'NOTE: The cell you are standing on is UNCLAIMED. You can claim it with stamn_claim_land.',
      );
    }
  } else {
    sections.push('', '(Waiting for world data from server...)');
  }

  // Recent events
  if (events.length > 0) {
    sections.push(
      '',
      '== RECENT EVENTS ==',
      ...events.map(
        (e) =>
          `- [${new Date(e.timestamp).toLocaleTimeString()}] ${e.summary}`,
      ),
    );
  }

  sections.push(
    '',
    'It is time to decide your next action. Use your stamn tools.',
    'Consider: moving to explore, claiming unclaimed land, trading with nearby agents.',
    'Pick ONE action and execute it now. Be decisive.',
  );

  return sections.join('\n');
}
