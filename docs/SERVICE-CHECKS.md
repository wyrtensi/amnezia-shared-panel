# Service checks: adding a new one

A service check answers one question from one node: *does this service work
from here?* It runs inside the node-agent, on the node's own network, from the
same public address the VPN traffic leaves from — so what it sees is what a
user on that node sees.

This document is about **adding checks**, which is meant to be cheap, and about
**adding rules**, which is meant to be possible.

---

## 1. The shape

A check is a **probe** (what to do) and a list of **assertions** (what must be
true of the result). All assertions must hold.

```jsonc
{
  "name": "Gemini",
  "probe": { "kind": "http", "url": "https://gemini.google.com/", "method": "GET", "timeoutMs": 10000 },
  "assertions": [
    { "type": "statusIn", "statuses": [200] },
    { "type": "bodyOccurrencesAtLeast", "value": "conversation-container", "count": 10 },
    { "type": "bodyOmits", "value": "account-rejected" }
  ],
  "intervalSec": 43200,
  "enabled": true
}
```

Both are open sets, stored as JSON rather than as columns. **Adding a check is
data.** Adding a *rule* is one entry in a registry — see §4.

---

## 2. The three results, and why the difference matters

| Status | Means | Shown to a user as |
|---|---|---|
| `ok` | the probe ran, every assertion held | works |
| `failed` | the probe ran, an assertion did not | unavailable |
| `error` | the probe could not run, **or this agent does not implement part of the check** | unknown |

`error` is not a lesser `failed`. It means *nothing is known about the service*.
A node that could not look must never report "blocked" — telling a user a
service is unavailable when the node never reached it is worse than telling them
nothing. This is why an unknown assertion type is an `error` and never a silent
pass.

---

## 3. Choosing what to assert on

**Derive a check from a diff of two captures, never from a scan of one.** On a
single blocked page, the absence of a marker cannot be distinguished from the
absence of evidence: not finding "not available in your country" tells you only
that one guessed string was absent, not that some other string separates the two
pages.

That rule has already changed an answer once. Gemini was written off as
"cannot be checked over HTTP" from the blocked capture alone; with the working
page beside it, raw substring counts gave a clean separator in minutes.

Prefer a **success** marker over a failure marker where one exists. A failure
marker only catches a block of the exact shape the service served on the day of
the capture; a success marker fails for *any* reason the working UI is missing —
a redesigned block page, a captive portal, a DNS hijack, an error shell.

Watch for near-misses. `input-area-container` appears **58** times on a blocked
Gemini page and **86** times on a working one: it reads like a chat-input class,
it sits one word away from a marker that *is* discriminating, and it would be
green from a blocked node in one direction and red from a working node in the
other.

---

## 4. Adding a new rule

Three edits, and the third is what keeps the fleet honest:

1. **`packages/contracts/src/index.ts`** — add the variant to
   `checkAssertionSchema`, its name to `CHECK_ASSERTION_TYPES`, and a line to
   `describeAssertion` (a `switch` with no default, so the compiler will tell
   you).
2. **`services/node-agent/src/services/checks/assertions.ts`** — add the
   evaluator to `ASSERTION_EVALUATORS`. It returns a short reason on failure or
   `null` on success. `SUPPORTED_ASSERTION_TYPES` is derived from the registry's
   own keys, so there is no list to remember to update.
3. **Ship the agent before the rule is used.** A node that does not implement
   the type reports `error`, which is safe but useless. `GET /server` reports
   `checkCapabilities`, so the panel can say which nodes are too old rather than
   leaving an admin to guess.

A new **probe kind** — DNS, TCP, TLS — is the same three steps against
`checkProbeSchema` and `PROBE_RUNNERS`. The runner deliberately knows nothing
about HTTP, so a TCP probe does not have to pretend to have a status code.

### The one rule that is not allowed as-is: regular expressions

Every evaluator is **linear in the size of the body**, and that is a constraint
rather than an accident. A regex built from an admin-supplied string can
backtrack catastrophically over a 64 KiB body, and these run inside the agent on
a host with one vCPU that is also carrying the tunnels — a runaway match blocks
the event loop and takes the node's API down with it.

`bodyOccurrencesAtLeast` exists because it covers what regexes were wanted for
here (counting a marker) at a cost bounded by the body length. If a real regex
is ever needed, it needs a worker thread with a deadline, and that decision
belongs in this document rather than inside whoever adds the rule.

---

## 5. What the node refuses

- **A target that resolves inside the node's own network.** A check URL is an
  admin-supplied string this process fetches from the node's network namespace,
  which is the shape of an SSRF primitive: the Docker socket, the AWG containers
  and the host's metadata service all sit behind addresses the panel cannot
  otherwise reach. The contract refuses `localhost` and friends **by name**; the
  agent refuses loopback, private, link-local, unique-local, carrier-grade NAT
  and reserved ranges **by address**, after resolution, which is the half a
  hostname cannot be trusted to tell you. Every answer must pass, not just the
  first — a public name with one private answer is DNS rebinding.
- **A check with no assertions.** Refused by the contract *and* by a table
  constraint. It is always green and looks exactly like a check that is passing.
- **A body assertion against a `HEAD` probe.** HEAD reads no body, so it could
  only ever fail — silently, and in the direction that reads as "blocked".
- **More than 64 KiB of body**, and **more than 15 s** per probe. The body cap
  is enforced by cancelling the stream, not by reading and discarding.

---

## 6. Available assertions

| Type | Passes when |
|---|---|
| `statusIn` | the status is one of `statuses` |
| `bodyContains` | the body contains `value` |
| `bodyOmits` | the body does not contain `value` |
| `bodyContainsAll` | the body contains every one of `values` |
| `bodyContainsAny` | the body contains at least one of `values` |
| `bodyOccurrencesAtLeast` | `value` appears at least `count` times (non-overlapping) |
| `bodyBytesAtLeast` | at least `count` bytes were read (capped at 64 KiB) |
| `finalUrlContains` | the URL the request landed on contains `value` |
| `finalUrlOmits` | it does not |
| `headerContains` | response header `name` contains `value` (name is case-insensitive) |

Probe kinds: `http` (`method`: `GET` or `HEAD`).
