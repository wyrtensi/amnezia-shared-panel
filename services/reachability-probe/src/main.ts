import { DEFAULT_API_KEY_FILE, loadApiKey, parseListen } from "./env.js";
import { execFileExec } from "./exec.js";
import { httpGet, pingLevel, tcpBannerLevel } from "./levels.js";
import { runAll, type RunDeps } from "./run.js";
import { createServer } from "./server.js";

const log = (line: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
};

const main = (): void => {
  let apiKey: string;
  let listen: { host: string; port: number };
  try {
    apiKey = loadApiKey(process.env.PROBE_API_KEY_FILE?.trim() || DEFAULT_API_KEY_FILE);
    listen = parseListen(process.env.PROBE_LISTEN);
  } catch (error) {
    process.stderr.write(`reachability-probe: ${error instanceof Error ? error.message : "bad settings"}\n`);
    process.exit(1);
  }

  const deps: RunDeps = {
    exec: execFileExec,
    httpGet,
    ping: (host) => pingLevel(execFileExec, host),
    tcpBanner: (host) => tcpBannerLevel(host),
    tmpDir: process.env.PROBE_TMP_DIR?.trim() || "/tmp",
    now: () => new Date(),
    log,
  };

  const server = createServer({
    apiKey,
    runner: (request, onProgress) => runAll(request, deps, onProgress),
    log,
  });
  server.listen(listen.port, listen.host, () => {
    log(`listening on ${listen.host}:${listen.port}`);
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
