import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

// Everything under infra/ and scripts/ is copied verbatim onto a Linux host and
// then read by sh, systemd, or docker compose. A CR at the end of a line breaks
// all three quietly.
//
// This is not hypothetical. `git archive` from a Windows checkout shipped the
// systemd unit templates with CRLF, because .gitattributes guarded *.sh and
// *.yaml but not *.service. install-agent-updater.sh fills its unit in with
//
//   sed 's#^Environment=NODE_AGENT_UPDATE_REPO=$#...#'
//
// whose `$` anchor no longer matched, so the substitution silently did nothing
// and every node answered the panel's agent update with "NODE_AGENT_UPDATE_REPO
// is not configured on this host" — a broken update path on the whole fleet,
// from a line ending.
const DEPLOYED_TREES = ["infra", "scripts"];

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", cwd: process.cwd() });

test("every file deployed to a server is checked out with LF", () => {
  const files = git("ls-files", "-z", ...DEPLOYED_TREES)
    .split("\0")
    .filter(Boolean);

  assert.ok(files.length > 0, "expected tracked files under " + DEPLOYED_TREES);

  // One `check-attr` call for the whole list: it answers per file, and asking
  // once per file turns a fast test into a few hundred git processes.
  const answers = execFileSync("git", ["check-attr", "--stdin", "-z", "eol"], {
    encoding: "utf8",
    cwd: process.cwd(),
    input: files.join("\0"),
  });

  const offenders = [];
  // -z output is a flat NUL-separated stream of (path, attribute, value).
  const fields = answers.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] !== "lf") offenders.push(`${fields[i]} (eol: ${fields[i + 2]})`);
  }

  assert.deepEqual(
    offenders,
    [],
    "add an eol=lf rule in .gitattributes for these:\n  " +
      offenders.join("\n  "),
  );
});
