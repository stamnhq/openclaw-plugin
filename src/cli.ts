import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { PluginApi, StamnConfig } from './types.js';
import { runDeviceLogin } from './auth.js';
import { getClient } from './service.js';

function getConfigPath(): string {
  return join(homedir(), '.openclaw', 'openclaw.json');
}

function writeStamnConfig(result: {
  apiKey: string;
  agentId: string;
  agentName: string;
  serverUrl: string;
}): void {
  const configPath = getConfigPath();
  let config: Record<string, any> = {};

  try {
    const raw = readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    // File doesn't exist or invalid — start fresh
  }

  // Ensure nested structure exists
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};
  if (!config.plugins.entries.stamn) config.plugins.entries.stamn = {};

  config.plugins.entries.stamn.enabled = true;
  config.plugins.entries.stamn.config = {
    ...config.plugins.entries.stamn.config,
    serverUrl: result.serverUrl,
    apiKey: result.apiKey,
    agentId: result.agentId,
    agentName: result.agentName,
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function registerStamnCli(api: PluginApi, config: StamnConfig): void {
  api.registerCli(
    ({ program }) => {
      const stamn = (program as any).command('stamn').description('Stamn world commands');

      stamn
        .command('login')
        .description('Authenticate and register an agent with Stamn')
        .option('--name <name>', 'Agent name')
        .option('--server <url>', 'Server URL', config.serverUrl)
        .action(async (opts: { name?: string; server: string }) => {
          try {
            console.log('Starting Stamn device login...');
            const result = await runDeviceLogin(opts.server, opts.name);

            writeStamnConfig({
              apiKey: result.apiKey,
              agentId: result.agentId,
              agentName: result.agentName,
              serverUrl: opts.server,
            });

            console.log();
            console.log(`  Agent "${result.agentName}" registered.`);
            console.log(`  Agent ID: ${result.agentId}`);
            console.log(`  Config written to ${getConfigPath()}`);
            console.log();
            console.log('  Restart the gateway to connect: openclaw gateway restart');
          } catch (err) {
            console.error(`Login failed: ${(err as Error).message}`);
            process.exitCode = 1;
          }
        });

      stamn
        .command('status')
        .description('Show Stamn agent connection status')
        .action(async () => {
          const client = getClient();

          console.log('Stamn Plugin Status');
          console.log('-------------------');
          console.log(`  Agent ID:    ${config.agentId || '(not configured)'}`);
          console.log(`  Agent Name:  ${config.agentName || '(not configured)'}`);
          console.log(`  Server:      ${config.serverUrl}`);
          console.log(`  Connected:   ${client?.isConnected ? 'yes' : 'no'}`);

          if (config.apiKey) {
            try {
              const res = await fetch(`${config.serverUrl}/v1/health`);
              console.log(`  Server:      ${res.ok ? 'healthy' : 'unhealthy'}`);
            } catch {
              console.log('  Server:      unreachable');
            }
          }
        });
    },
    { commands: ['stamn'] },
  );
}
