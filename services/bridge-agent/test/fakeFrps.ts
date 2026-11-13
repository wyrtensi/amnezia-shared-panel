import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

export type Reply = { status?: number; body?: string; hang?: boolean };
export type Routes = Record<string, Reply>;

/** A loopback stand-in for the frps dashboard: basic auth plus canned replies per path. */
export const startFakeFrps = async (
  routes: Routes,
  credentials = { user: "fx", password: "fxpass" },
): Promise<{ server: Server; baseUrl: string; seenAuth: string[]; close: () => Promise<void> }> => {
  const seenAuth: string[] = [];
  const expected = `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString("base64")}`;
  const server = createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? "");
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("Unauthorized");
      return;
    }
    const reply = routes[req.url ?? ""];
    if (!reply) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (reply.hang) return;
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    res.end(reply.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    seenAuth,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
