import type { Exec, ExecResult } from "../src/exec.js";

export type ExecCall = { cmd: string; args: string[] };

/**
 * A recording Exec. `respond` decides each result; the default is success
 * with empty output. Handshake polls answer with `handshakeEpoch`.
 */
export const recordingExec = (
  respond: (call: ExecCall) => Partial<ExecResult> | Promise<Partial<ExecResult>> = () => ({}),
) => {
  const calls: ExecCall[] = [];
  const exec: Exec = async (cmd, args) => {
    const call = { cmd, args: [...args] };
    calls.push(call);
    const result = await respond(call);
    return { code: 0, stdout: "", stderr: "", ...result };
  };
  return { exec, calls, lines: () => calls.map((c) => [c.cmd, ...c.args].join(" ")) };
};

export const isHandshakePoll = (call: ExecCall): boolean =>
  call.cmd === "awg" && call.args[0] === "show" && call.args[2] === "latest-handshakes";

/** A clock that only moves when the code under test sleeps. */
export const fakeClock = (start = 1_700_000_000_000) => {
  let t = start;
  return {
    now: () => t,
    date: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
};
