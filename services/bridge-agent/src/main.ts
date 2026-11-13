import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { readAgentVersion } from "./types.js";

const log = (line: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
};

const main = (): void => {
  let config: ReturnType<typeof loadConfig>;
  let agentVersion: string;
  try {
    config = loadConfig(process.env);
    agentVersion = readAgentVersion();
  } catch (error) {
    process.stderr.write(`bridge-agent: ${error instanceof Error ? error.message : "bad settings"}\n`);
    process.exit(1);
  }

  const server = createServer({
    apiToken: config.apiToken,
    context: { bridgeId: config.bridgeId, agentVersion, applied: config.applied, frps: config.frps },
  });
  server.listen(config.listen.port, config.listen.host, () => {
    log(`bridge ${config.bridgeId} agent ${agentVersion} listening on ${config.listen.host}:${config.listen.port}`);
  });

  const stop = (): void => {
    log("stopping");
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
};

main();
