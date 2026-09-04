# Runbook: calibrating the seeded service checks

**Run this once, after the three seeded checks first reach a fleet.** It is
read-only until its last step.

The three checks shipped with the panel were derived from saved browser pages —
a blocked one and a working one. What a browser saved after JavaScript ran is
not proof of what a plain HTTP fetch sees, and the node fetches. This run is
what turns the reasoning into a measurement.

You need **at least one node you believe is blocked and one you believe is
not**. A check that reads the same from both is as useless as one that is always
green, and only two readings can tell those apart.

---

## 1. Get a reading now

The seeded period is 12 hours, so without this you would wait for one.

- Admin → the service-checks card → **Run now** on each of the three, or
- `amnezia-panel check-run <id>` over SSH.

Run now marks the check due; the reading appears after the next telemetry poll,
within about a minute.

## 2. Write down what came back

Per node and per check, three columns: the internal status (`ok` / `failed` /
`error`), the HTTP status, and the **final URL**. The final URL is the whole
signal for a service that answers a redirect rather than an error, and it is the
one column you cannot reconstruct afterwards.

## 3. Read it

| Check | From a **blocked** node | From an **unblocked** node |
|---|---|---|
| Google Flow | `failed`, final URL contains `unsupported-country` | `ok` |
| NotebookLM | `failed`, final URL shows `notebook.google/?location=unsupported` | `ok` |
| Google Gemini | `failed` | `ok` |

**Gemini is the odd one out — read it the other way round.** It asserts that the
chat UI is *present*, so `ok` is the interesting reading and `failed` is the
expected one from a blocked node. Two failure modes to tell apart from the
`detail` column:

- `body contains "conversation-container" 0 times, wanted at least 10` **on an
  unblocked node** → the marker is not in the served HTML, only in the DOM the
  browser builds. Try the alternatives in order — `above-input-area`, then
  `chat-history-list` — because a plain fetch may ship a different Angular style
  bundle than the capture shows. If none of them work, **disable the check** and
  record the finding.
- `body contains "account-rejected"` **on a blocked node** → the block is
  visible server-side and the check is working exactly as designed. Nothing to
  change.

An `error` on every node is not a verdict about the service. Read the detail: a
node that predates a rule says so by name (`unsupported assertion type: …`) and
needs an agent update, not a changed assertion.

## 4. Only now change anything

Two changes are on the table: **disable a check**, or **adjust one assertion
string**. That is the whole list.

**Do not reach for a headless browser.** If a marker is not in the served HTML,
the honest outcome is that the check cannot be made to work over plain HTTP —
not that the node should start running a browser. Record what you observed
(status, HTTP status, final URL, detail) so the next person starts from a
measurement rather than repeating this run.

## 5. Adding a fourth check

Derive the marker from a **diff of two captures**, never from a scan of one. On
a single blocked page the absence of a marker cannot be distinguished from the
absence of evidence. `docs/SERVICE-CHECKS.md` has the rules and the list of
available assertions.
