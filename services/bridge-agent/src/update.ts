import { closeSync, constants, fstatSync, fsyncSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

/**
 * The agent's half of an independent bridge-agent update (`/v1/update`).
 *
 * The agent never touches Docker. It writes a bounded request into the host
 * spool (`<spool>/requests/<operationId>.json`, the only directory it may
 * write) and reads back the host updater's per-operation result
 * (`<spool>/results/<operationId>.json`, mounted read-only). The host's
 * systemd updater (`infra/bridge/bridge-agent-update.sh`) validates the
 * request again and owns the replacement.
 *
 * Who decides "started" versus "expired" (at-most-once): a result file, once
 * the host wrote one, is reported verbatim and the agent never applies its own
 * clock to it. Only a request the host has not claimed yet is judged by the
 * clock: `queued` before `notAfter`, `expired` from then on. The host claims a
 * request by writing a `queued` result BEFORE it re-reads the clock and starts,
 * so an `expired` answer from the agent can never be followed by a start.
 */

/** Must equal `BRIDGE_AGENT_UPDATE_AGENT_STATES` in packages/contracts (a test pins it). */
export const UPDATE_AGENT_STATES = [
  "queued",
  "picked_up",
  "staging",
  "replacing",
  "health_check",
  "succeeded",
  "rolled_back",
  "rollback_failed",
  "failed",
  "expired",
] as const;
export type UpdateAgentState = (typeof UPDATE_AGENT_STATES)[number];

const TERMINAL: ReadonlySet<UpdateAgentState> = new Set([
  "succeeded",
  "rolled_back",
  "rollback_failed",
  "failed",
  "expired",
]);
export const isTerminalUpdateState = (state: UpdateAgentState): boolean => TERMINAL.has(state);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** `Date#toISOString()` shape, which is what the panel sends and the host updater re-validates. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** A bare repository name (no tag, no digest); same character set as install-bridge.sh. */
export const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,254}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Bound on a spool record and on the POST body. */
export const MAX_UPDATE_RECORD_BYTES = 4096;

const isoTime = z.string().regex(ISO_UTC).refine((value) => Number.isFinite(Date.parse(value)));

/** `POST /v1/update` body (the panel's `bridgeAgentUpdateRequestSchema`, with lowercase ids). */
export const updateRequestSchema = z.object({
  operationId: z.string().regex(UUID),
  imageRepository: z.string().regex(REPOSITORY),
  imageDigest: z.string().regex(DIGEST),
  notAfter: isoTime,
});
export type UpdateRequest = z.infer<typeof updateRequestSchema>;

const storedRequestSchema = updateRequestSchema.extend({ receivedAt: isoTime });
type StoredRequest = z.infer<typeof storedRequestSchema>;

/** What the host updater writes. Intent fields are absent only for a request it refused unread. */
const resultSchema = z.object({
  operationId: z.string().regex(UUID),
  imageRepository: z.string().regex(REPOSITORY).optional(),
  imageDigest: z.string().regex(DIGEST).optional(),
  notAfter: isoTime.optional(),
  state: z.enum(UPDATE_AGENT_STATES),
  updatedAt: z.string().min(1).max(64),
  errorCode: z.string().regex(ERROR_CODE).optional(),
});
type StoredResult = z.infer<typeof resultSchema>;

/** The wire status (`bridgeAgentUpdateStatusSchema` in packages/contracts). */
export type UpdateStatus = {
  operationId: string;
  state: UpdateAgentState;
  updatedAt: string;
  errorCode?: string;
};

export type UpdateSpool = { requestsDir: string; resultsDir: string };

export const spoolOf = (spoolDir: string): UpdateSpool => ({
  requestsDir: join(spoolDir, "requests"),
  resultsDir: join(spoolDir, "results"),
});

/** A spool record exists but cannot be trusted or read: the caller answers 5xx, never 404. */
export class SpoolError extends Error {}

/** Synchronous on purpose: check-and-write runs as one step of the event loop, so two POSTs cannot interleave. */
const readRecord = (path: string): unknown => {
  let fd: number;
  try {
    // O_NOFOLLOW: a record is a regular file the agent or the host wrote, never a link.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw new SpoolError("spool record unreadable");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_UPDATE_RECORD_BYTES) throw new SpoolError("spool record invalid");
    const buffer = Buffer.alloc(MAX_UPDATE_RECORD_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > MAX_UPDATE_RECORD_BYTES) throw new SpoolError("spool record invalid");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } catch (error) {
    if (error instanceof SpoolError) throw error;
    throw new SpoolError("spool record invalid");
  } finally {
    closeSync(fd);
  }
};

const readResult = (spool: UpdateSpool, operationId: string): StoredResult | undefined => {
  const raw = readRecord(join(spool.resultsDir, `${operationId}.json`));
  if (raw === undefined) return undefined;
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.operationId !== operationId) throw new SpoolError("result invalid");
  return parsed.data;
};

const readRequest = (spool: UpdateSpool, operationId: string): StoredRequest | undefined => {
  const raw = readRecord(join(spool.requestsDir, `${operationId}.json`));
  if (raw === undefined) return undefined;
  const parsed = storedRequestSchema.safeParse(raw);
  if (!parsed.success || parsed.data.operationId !== operationId) throw new SpoolError("request invalid");
  return parsed.data;
};

const pendingStatus = (request: StoredRequest, now: Date): UpdateStatus =>
  now.getTime() >= Date.parse(request.notAfter)
    ? { operationId: request.operationId, state: "expired", updatedAt: request.notAfter }
    : { operationId: request.operationId, state: "queued", updatedAt: request.receivedAt };

const resultStatus = (result: StoredResult): UpdateStatus => ({
  operationId: result.operationId,
  state: result.state,
  updatedAt: result.updatedAt,
  ...(result.errorCode ? { errorCode: result.errorCode } : {}),
});

type Intent = { imageRepository?: string; imageDigest?: string; notAfter?: string };
type Known = { intent: Intent; status: UpdateStatus };

/** The operation's known state: the host's result if any, else the agent's own pending request. */
const lookup = (spool: UpdateSpool, operationId: string, now: Date): Known | undefined => {
  const result = readResult(spool, operationId);
  if (result) return { intent: result, status: resultStatus(result) };
  const request = readRequest(spool, operationId);
  if (request) return { intent: request, status: pendingStatus(request, now) };
  return undefined;
};

/** `GET /v1/update?operationId=`: undefined means positively no record of it. */
export const readUpdate = (spool: UpdateSpool, operationId: string, now: Date): UpdateStatus | undefined =>
  lookup(spool, operationId, now)?.status;

const sameInstant = (a: string | undefined, b: string): boolean =>
  a !== undefined && Date.parse(a) === Date.parse(b);

const sameIntent = (known: Intent, request: UpdateRequest): boolean =>
  known.imageRepository === request.imageRepository &&
  known.imageDigest === request.imageDigest &&
  sameInstant(known.notAfter, request.notAfter);

const operationIds = (dir: string): string[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw new SpoolError("spool unreadable");
  }
  return names
    .filter((name) => name.endsWith(".json") && UUID.test(name.slice(0, -5)))
    .map((name) => name.slice(0, -5));
};

/** Is any operation other than `operationId` still able to run or running on this host? */
const anotherInFlight = (spool: UpdateSpool, operationId: string, now: Date): boolean => {
  const ids = new Set([...operationIds(spool.resultsDir), ...operationIds(spool.requestsDir)]);
  ids.delete(operationId);
  for (const id of ids) {
    const known = lookup(spool, id, now);
    if (known && !isTerminalUpdateState(known.status.state)) return true;
  }
  return false;
};

/** Atomic create: a temp file in the same directory (not matching the updater's `*.json` watch), then rename. */
const writeRequest = (spool: UpdateSpool, record: StoredRequest): void => {
  const tmp = join(spool.requestsDir, `.${record.operationId}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(tmp);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(tmp, join(spool.requestsDir, `${record.operationId}.json`));
  } catch (error) {
    unlinkSync(tmp);
    throw error;
  }
};

export type SubmitOutcome =
  | { kind: "accepted"; created: boolean; status: UpdateStatus }
  /** Same id, different intent. */
  | { kind: "conflict" }
  /** Another operation is queued or running on this host. */
  | { kind: "busy" };

/**
 * `POST /v1/update` after the body and repository were validated. A replay of
 * a known id returns its state and writes nothing. An intent that arrives at
 * or after `notAfter` is recorded (so a later GET agrees) and answered
 * `expired`: the host updater refuses to start it.
 */
export const submitUpdate = (spool: UpdateSpool, request: UpdateRequest, now: Date): SubmitOutcome => {
  const known = lookup(spool, request.operationId, now);
  if (known) {
    return sameIntent(known.intent, request)
      ? { kind: "accepted", created: false, status: known.status }
      : { kind: "conflict" };
  }
  const record: StoredRequest = { ...request, receivedAt: now.toISOString() };
  const late = now.getTime() >= Date.parse(request.notAfter);
  if (!late && anotherInFlight(spool, request.operationId, now)) return { kind: "busy" };
  writeRequest(spool, record);
  return { kind: "accepted", created: true, status: pendingStatus(record, now) };
};

/** Expected lead of `notAfter` on receipt is the panel's 120 s pickup window minus delivery time. */
const SKEW_AHEAD_MS = 180_000;
const SKEW_BEHIND_MS = 60_000;

/** A bounded, secret-free line when `notAfter` is far from local time, else null. */
export const clockSkewNote = (request: UpdateRequest, now: Date): string | null => {
  const leadMs = Date.parse(request.notAfter) - now.getTime();
  if (leadMs <= SKEW_AHEAD_MS && leadMs >= -SKEW_BEHIND_MS) return null;
  const seconds = Math.round(leadMs / 1000);
  return `update ${request.operationId}: notAfter is ${seconds}s from local time (expected 0..120s); check the clocks of the panel and this bridge`;
};
