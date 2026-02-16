import { randomUUID } from 'crypto';
import type { PluginApi, MoveDirection, SpendRequestPayload } from './types.js';
import { getClient } from './service.js';
import { worldTracker } from './world-state.js';

/** OpenClaw expects tool results as { content: [{ type: 'text', text }] } */
function toolResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/** Shared move logic — direction is hardcoded per tool, no args needed */
async function doMove(direction: MoveDirection) {
  const client = getClient();
  if (!client?.isConnected) return toolResult('Not connected to Stamn server.');

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
}

/**
 * Register Stamn actions as agent tools so the AI can call them
 * during its reasoning loop (via OpenAI function calling protocol).
 *
 * IMPORTANT: Tools that need parameters are broken in the current OpenClaw
 * build (tool call IDs get passed instead of actual args). So movement is
 * split into 4 zero-parameter tools, and offer_land auto-selects the best trade.
 */
export function registerAgentTools(api: PluginApi): void {
  // ── Movement (4 separate zero-param tools) ─────────────────────────────

  api.registerTool({
    name: 'stamn_move_up',
    description: 'Move your agent UP (north) on the world grid.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => doMove('up'),
  });

  api.registerTool({
    name: 'stamn_move_down',
    description: 'Move your agent DOWN (south) on the world grid.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => doMove('down'),
  });

  api.registerTool({
    name: 'stamn_move_left',
    description: 'Move your agent LEFT (west) on the world grid.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => doMove('left'),
  });

  api.registerTool({
    name: 'stamn_move_right',
    description: 'Move your agent RIGHT (east) on the world grid.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => doMove('right'),
  });

  // ── Land claiming ──────────────────────────────────────────────────────

  api.registerTool({
    name: 'stamn_claim_land',
    description:
      'Claim the land parcel at your current position on the grid. Only works on unclaimed cells. Returns the result (success or denial with reason).',
    parameters: { type: 'object', properties: {}, required: [] },
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

      const lines = [`Land claim denied: ${result.reason} (${result.code}).`];
      if (result.code === 'already_owned' && world) {
        lines.push(`Cell (${world.position.x}, ${world.position.y}) is already owned. Move to an unclaimed cell.`);
      } else if (result.code === 'insufficient_balance' && world) {
        lines.push(`Your balance: ${world.balanceCents} cents. You own ${world.ownedLand.length} parcels (free claims may be exhausted).`);
        lines.push('Sell land to other agents to earn USDC, then claim more.');
      }
      return toolResult(lines.join('\n'));
    },
  });

  // ── Smart land offer (zero params — auto-picks best trade) ─────────────

  api.registerTool({
    name: 'stamn_offer_land',
    description:
      'Automatically offer your best land parcel to the nearest agent at a fair price. Picks the parcel closest to the buyer and prices it based on distance. No parameters needed.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const client = getClient();
      if (!client?.isConnected) return toolResult('Not connected to Stamn server.');

      const world = worldTracker.getWorld();
      if (!world) return toolResult('No world data yet. Wait for a world update.');

      if (world.ownedLand.length === 0) {
        return toolResult('You own no land to sell. Claim some first.');
      }

      // Find nearest agent (from allAgents, excluding self)
      const allAgents = world.allAgents ?? [];
      const others = allAgents.filter((a) => !world.ownedLand.some(() => false));
      // Use nearbyAgents if available, otherwise allAgents
      const candidates = world.nearbyAgents.length > 0
        ? world.nearbyAgents
        : allAgents.filter((a) => {
            // Exclude self — if agent's position matches ours and they're not in nearbyAgents
            return !(a.x === world.position.x && a.y === world.position.y && a.name === world.nearbyAgents[0]?.name);
          });

      if (candidates.length === 0) {
        return toolResult(
          `No other agents found to trade with. ${allAgents.length} agent(s) total online. Move around to find trading partners.`,
        );
      }

      // Pick the closest other agent
      let bestAgent = candidates[0];
      let bestDist = Infinity;
      for (const agent of candidates) {
        const dist = Math.abs(agent.x - world.position.x) + Math.abs(agent.y - world.position.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestAgent = agent;
        }
      }

      // Pick the parcel closest to the buyer
      let bestParcel = world.ownedLand[0];
      let bestParcelDist = Infinity;
      for (const parcel of world.ownedLand) {
        const dist = Math.abs(parcel.x - bestAgent.x) + Math.abs(parcel.y - bestAgent.y);
        if (dist < bestParcelDist) {
          bestParcelDist = dist;
          bestParcel = parcel;
        }
      }

      // Price based on proximity — closer land is worth more
      const basePriceCents = bestParcelDist <= 5 ? 500 : bestParcelDist <= 15 ? 200 : 100;

      client.offerLand(bestParcel.x, bestParcel.y, bestAgent.agentId, basePriceCents);

      return toolResult(
        `Offered land (${bestParcel.x}, ${bestParcel.y}) to ${bestAgent.name} (${bestDist} cells away) for ${basePriceCents} cents ($${(basePriceCents / 100).toFixed(2)}).`,
      );
    },
  });

  // ── List all owned land for sale ───────────────────────────────────────

  api.registerTool({
    name: 'stamn_list_all_land',
    description:
      'List ALL your owned land parcels for sale at a fair price based on location. Dashboard viewers and other agents will see the listings.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const client = getClient();
      if (!client?.isConnected) return toolResult('Not connected to Stamn server.');

      const world = worldTracker.getWorld();
      if (!world) return toolResult('No world data yet.');

      if (world.ownedLand.length === 0) {
        return toolResult('You own no land to list.');
      }

      // List each parcel with a price based on proximity to center / other agents
      const listed: string[] = [];
      for (const parcel of world.ownedLand) {
        // Base price: 200 cents, +100 if near center, +100 if near other agents
        let priceCents = 200;
        const distToCenter = Math.abs(parcel.x - 50) + Math.abs(parcel.y - 50);
        if (distToCenter < 30) priceCents += 100;

        for (const agent of (world.allAgents ?? [])) {
          const dist = Math.abs(parcel.x - agent.x) + Math.abs(parcel.y - agent.y);
          if (dist <= 10) {
            priceCents += 100;
            break;
          }
        }

        client.listLand(parcel.x, parcel.y, priceCents);
        listed.push(`(${parcel.x}, ${parcel.y}) at ${priceCents} cents`);
      }

      return toolResult(`Listed ${listed.length} parcels for sale:\n${listed.join('\n')}`);
    },
  });

  // ── Spend (kept for future use, but params may not work) ───────────────

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

  // ── Status ─────────────────────────────────────────────────────────────

  api.registerTool({
    name: 'stamn_get_status',
    description:
      'Get your current Stamn agent status: connection state, position, balance, land, and nearby agents.',
    parameters: { type: 'object', properties: {}, required: [] },
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
        `Total agents online: ${world.allAgents?.length ?? 'unknown'}`,
      ];
      return toolResult(lines.join('\n'));
    },
  });
}
