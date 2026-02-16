import { randomUUID } from 'crypto';
import type { PluginApi, MoveDirection, SpendRequestPayload } from './types.js';
import { getClient } from './service.js';
import { worldTracker } from './world-state.js';

/** OpenClaw expects tool results as { content: [{ type: 'text', text }] } */
function toolResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/** Try every reasonable way to extract a direction from args */
function extractDirection(args: Record<string, unknown>, valid: MoveDirection[]): MoveDirection | null {
  // Direct property access
  const candidates = [args.direction, args.dir, args.d, args.move];

  // First value in the object
  const values = Object.values(args);
  if (values.length > 0) candidates.push(values[0]);

  // Try stringified whole object (model might pass {"direction":"up"} as a string)
  candidates.push(args);

  for (const raw of candidates) {
    if (raw == null) continue;
    const str = (typeof raw === 'string' ? raw : typeof raw === 'object' ? JSON.stringify(raw) : String(raw))
      .toLowerCase().trim();
    // Try direct match
    if (valid.includes(str as MoveDirection)) return str as MoveDirection;
    // Try to find a direction word inside the string
    for (const dir of valid) {
      if (str.includes(dir)) return dir;
    }
  }

  return null;
}

/**
 * Register Stamn actions as agent tools so the AI can call them
 * during its reasoning loop (via OpenAI function calling protocol).
 *
 * These are different from auto-reply commands (registerCommand) —
 * agent tools are invoked BY the AI, not by users typing slash commands.
 */
export function registerAgentTools(api: PluginApi): void {
  api.registerTool({
    name: 'stamn_move',
    description:
      'Move your agent on the Stamn 100x100 world grid. Returns confirmation or error.',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          description: 'Direction to move',
          enum: ['up', 'down', 'left', 'right'],
        },
      },
      required: ['direction'],
    },
    execute: async (args) => {
      const client = getClient();
      if (!client?.isConnected) return toolResult('Not connected to Stamn server.');

      // Handle various arg formats from different AI models
      const valid: MoveDirection[] = ['up', 'down', 'left', 'right'];
      const direction = extractDirection(args, valid);

      console.log('[stamn_move] args:', JSON.stringify(args), '→ direction:', direction);

      if (!direction) {
        return toolResult(`Invalid direction. Use: up, down, left, right. (received args: ${JSON.stringify(args)})`);
      }

      client.move(direction);

      // Wait briefly for world update so we can report new position
      await new Promise((r) => setTimeout(r, 500));
      const world = worldTracker.getWorld();
      if (world) {
        const onUnclaimed = !world.nearbyLand.some(
          (l) => l.x === world.position.x && l.y === world.position.y,
        );
        return toolResult(
          `Moved ${direction}. Now at (${world.position.x}, ${world.position.y}).${onUnclaimed ? ' This cell is UNCLAIMED — you can claim it.' : ''}`,
        );
      }
      return toolResult(`Moved ${direction}.`);
    },
  });

  api.registerTool({
    name: 'stamn_claim_land',
    description:
      'Claim the land parcel at your current position on the grid. Only works on unclaimed cells. Returns the result (success or denial with reason).',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async () => {
      const client = getClient();
      if (!client?.isConnected) return toolResult('Not connected to Stamn server.');

      const world = worldTracker.getWorld();

      // Pre-check: are we standing on owned land?
      if (world) {
        const ownedHere = world.nearbyLand.find(
          (l) => l.x === world.position.x && l.y === world.position.y,
        );
        if (ownedHere) {
          return toolResult(
            `Cannot claim: cell (${world.position.x}, ${world.position.y}) is already owned by ${ownedHere.ownerAgentId}. Move to an unclaimed cell first.`,
          );
        }
      }

      const result = await client.claimLandAndWait();

      if (result.success) {
        return toolResult(
          `Land claimed at (${result.x}, ${result.y}). You now own ${(world?.ownedLand.length ?? 0) + 1} parcels.`,
        );
      }

      // Provide actionable context on denial
      const lines = [`Land claim denied: ${result.reason} (${result.code}).`];
      if (result.code === 'already_owned' && world) {
        lines.push(`Cell (${world.position.x}, ${world.position.y}) is already owned. Move to an unclaimed cell.`);
      } else if (result.code === 'insufficient_balance' && world) {
        lines.push(`Your balance: ${world.balanceCents} cents. You own ${world.ownedLand.length} parcels (free claims may be exhausted).`);
        lines.push('Move and claim unclaimed cells, or earn more balance.');
      }
      return toolResult(lines.join('\n'));
    },
  });

  api.registerTool({
    name: 'stamn_offer_land',
    description: 'Offer to sell a land parcel you own to another agent at a specified price.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'string', description: 'X coordinate of the land parcel' },
        y: { type: 'string', description: 'Y coordinate of the land parcel' },
        toAgentId: { type: 'string', description: 'UUID of the agent to sell to' },
        priceCents: { type: 'string', description: 'Price in cents (e.g. 500 = $5.00)' },
      },
      required: ['x', 'y', 'toAgentId', 'priceCents'],
    },
    execute: async (args) => {
      const client = getClient();
      if (!client?.isConnected) return toolResult('Not connected to Stamn server.');

      const x = parseInt(args.x as string, 10);
      const y = parseInt(args.y as string, 10);
      const priceCents = parseInt(args.priceCents as string, 10);

      if (isNaN(x) || isNaN(y) || isNaN(priceCents)) {
        return toolResult('x, y, and priceCents must be numbers.');
      }

      client.offerLand(x, y, args.toAgentId as string, priceCents);
      return toolResult(`Offered land (${x}, ${y}) to ${args.toAgentId} for ${priceCents} cents.`);
    },
  });

  api.registerTool({
    name: 'stamn_spend',
    description: 'Request a USDC spend from the agent wallet for a service or purchase.',
    parameters: {
      type: 'object',
      properties: {
        amountCents: { type: 'string', description: 'Amount in cents (e.g. 100 = $1.00)' },
        vendor: { type: 'string', description: 'Name of the vendor or service' },
        description: { type: 'string', description: 'What this spend is for' },
      },
      required: ['amountCents', 'vendor', 'description'],
    },
    execute: async (args) => {
      const client = getClient();
      if (!client?.isConnected) return toolResult('Not connected to Stamn server.');

      const amountCents = parseInt(args.amountCents as string, 10);
      if (isNaN(amountCents) || amountCents <= 0) {
        return toolResult('amountCents must be a positive number.');
      }

      const payload: SpendRequestPayload = {
        requestId: randomUUID(),
        amountCents,
        currency: 'USDC',
        category: 'api',
        rail: 'internal',
        vendor: args.vendor as string,
        description: args.description as string,
      };

      client.requestSpend(payload);
      return toolResult(`Spend request sent: ${amountCents} cents to ${args.vendor} — "${args.description}"`);
    },
  });

  api.registerTool({
    name: 'stamn_get_status',
    description:
      'Get your current Stamn agent status: connection state, agent ID, and server info.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async () => {
      const client = getClient();
      if (!client) return toolResult('Stamn plugin not initialized. Check config.');
      if (!client.isConnected) return toolResult('Disconnected from Stamn world (reconnecting...).');

      const world = worldTracker.getWorld();
      if (!world) return toolResult('Connected but no world data received yet.');

      const lines = [
        'Connected to Stamn world.',
        `Position: (${world.position.x}, ${world.position.y})`,
        `Balance: ${world.balanceCents} cents`,
        `Owned land: ${world.ownedLand.length} parcels`,
        `Nearby agents: ${world.nearbyAgents.length}`,
      ];
      return toolResult(lines.join('\n'));
    },
  });
}
