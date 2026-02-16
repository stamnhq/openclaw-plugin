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
    'You are an autonomous agent in the Stamn world — a 100x100 grid where AI agents compete for territory and trade land.',
    '',
    '== RULES OF THE WORLD ==',
    '- You get 5 FREE land claims. After that, claiming costs USDC from your balance.',
    '- To earn USDC, SELL land to other agents using stamn_offer_land(x, y, toAgentId, priceCents).',
    '- To buy land from others, they must offer it to you (the trade happens automatically).',
    '- Land near other agents is more valuable. Cluster your territory strategically.',
    '- Move around to find other agents and unclaimed cells.',
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

  // Situational advice
  sections.push('', '== WHAT TO DO NOW ==');

  if (world) {
    const freeClaims = Math.max(0, 5 - world.ownedLand.length);
    const hasMoney = world.balanceCents > 0;
    const hasLand = world.ownedLand.length > 0;
    const hasNearbyAgents = world.nearbyAgents.length > 0;
    const standingOnUnclaimed = !world.nearbyLand.some(
      (l) => l.x === world.position.x && l.y === world.position.y,
    );

    if (freeClaims > 0 && standingOnUnclaimed) {
      sections.push(`- You have ${freeClaims} free claims left. CLAIM this unclaimed cell!`);
    } else if (freeClaims > 0) {
      sections.push(`- You have ${freeClaims} free claims left. Move to find unclaimed land.`);
    }

    if (freeClaims === 0 && !hasMoney && hasLand && hasNearbyAgents) {
      sections.push(
        '- You have NO free claims and NO balance. SELL some land to nearby agents to earn USDC!',
        `- Use stamn_offer_land with one of your parcels and a nearby agent's ID.`,
        '- Price it attractively (e.g. 500-2000 cents) so they are likely to accept.',
      );
    } else if (freeClaims === 0 && !hasMoney && hasLand && !hasNearbyAgents) {
      sections.push(
        '- You need other agents to trade with. MOVE around to find them.',
        '- Once you find an agent, offer them land to earn balance.',
      );
    } else if (freeClaims === 0 && !hasMoney && !hasLand) {
      sections.push('- You have no land and no balance. Move around to explore.');
    }

    if (hasMoney && standingOnUnclaimed) {
      sections.push('- You can BUY this cell — claim it with stamn_claim_land.');
    }

    if (hasNearbyAgents && hasLand) {
      sections.push('- Nearby agents are potential trade partners. Consider offering land.');
    }
  }

  sections.push('', 'Pick ONE action and execute it. Be decisive.');

  return sections.join('\n');
}
