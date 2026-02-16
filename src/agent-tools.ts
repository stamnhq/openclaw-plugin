import { randomUUID } from 'crypto';
import type { PluginApi, MoveDirection, SpendRequestPayload } from './types.js';
import { getClient } from './service.js';

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
      if (!client?.isConnected) return 'Not connected to Stamn server.';

      const direction = (args.direction as string).toLowerCase() as MoveDirection;
      client.move(direction);
      return `Moved ${direction}.`;
    },
  });

  api.registerTool({
    name: 'stamn_claim_land',
    description:
      'Claim the land parcel at your current position on the grid. Only works on unclaimed cells.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const client = getClient();
      if (!client?.isConnected) return 'Not connected to Stamn server.';

      client.claimLand();
      return 'Land claim request sent.';
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
      if (!client?.isConnected) return 'Not connected to Stamn server.';

      const x = parseInt(args.x as string, 10);
      const y = parseInt(args.y as string, 10);
      const priceCents = parseInt(args.priceCents as string, 10);

      if (isNaN(x) || isNaN(y) || isNaN(priceCents)) {
        return 'x, y, and priceCents must be numbers.';
      }

      client.offerLand(x, y, args.toAgentId as string, priceCents);
      return `Offered land (${x}, ${y}) to ${args.toAgentId} for ${priceCents} cents.`;
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
      if (!client?.isConnected) return 'Not connected to Stamn server.';

      const amountCents = parseInt(args.amountCents as string, 10);
      if (isNaN(amountCents) || amountCents <= 0) {
        return 'amountCents must be a positive number.';
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
      return `Spend request sent: ${amountCents} cents to ${args.vendor} — "${args.description}"`;
    },
  });

  api.registerTool({
    name: 'stamn_get_status',
    description:
      'Get your current Stamn agent status: connection state, agent ID, and server info.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const client = getClient();
      if (!client) return 'Stamn plugin not initialized. Check config.';
      return client.isConnected
        ? 'Connected to Stamn world.'
        : 'Disconnected from Stamn world (reconnecting...).';
    },
  });
}
