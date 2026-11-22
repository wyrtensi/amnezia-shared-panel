# Client parameters view, per-user device profiles, pinning and CLI

Status: approved in conversation 2026-11-22. Builds on
`2026-11-21-config-profile-per-user-and-key-design.md` (levels, MTU, device
rules per address) and `docs/AWG-GENERATOR.md`.

## Intent

The administrator tunes AWG 3.1 client profiles per node, address, device
type, user and key, but cannot see what a key actually exports: the editor
shows a preset and ranges, and "as issued by the node" shows nothing. They
want to open the real parameters of any key or address (above all when the
profile is not a stock preset, or not from the panel at all), give a user
their own profile per device type, and pin what a key runs today to its
owner so later node or address edits do not reach that user. Everything is
admin-only, comfortable to use, styled like the rest of the admin UI, and
available from the CLI too, together with the settings added in v0.15.20-22
that the CLI still lacks.

## Goals

1. **Parameters view** (read-only, admin only) for a key and for a node
   address.
2. **Per-user device rules**: a profile and/or MTU per device type of one
   user.
3. **Pin**: copy a key's effective profile and MTU to its owner, either as the
   user's profile or as the user's rule for the key's device type.
4. **CLI** for all client-settings levels, presets, the parameters view and
   pinning.

## Non-goals

- Pinning exact drawn values (a "frozen values" profile type). Chosen against
  in conversation: a pin copies the profile settings, so values are still
  drawn per key and Refresh config still redraws them.
- Anything visible to users in their own dashboard.
- Changing server-side geometry (S1-S4, H1-H4, header protection key): those
  belong to the node and are shown for information only.
- The reachability probe: it keeps measuring the address and node levels only.

## Behaviour

### Levels

`AWG_CONFIG_LEVELS` becomes `key > userDevice > user > device > address > node`
(`userDevice`: the owner's rule for the key's device type; `device` stays the
address's rule). Profile and MTU resolve independently, as today. A key with
device type `unspecified` matches no device rule at either level. `userDevice`
is a manual level: a key resolved from it is not probe-checked.

### Parameters view

`GET /api/admin/keys/:id/client-parameters` returns, for an AWG 3.1 key:

- `exported`: the client Interface parameters the key's download carries now,
  built by the same projection as the export (saved artifact, saved client
  profile, resolved generator and MTU), without recording an export, without
  audit noise and without changing anything;
  Draws are deterministic (key id, settings, configuration revision), so the
  view equals the next download until a setting or a refresh changes;
- `issued`: the same parameters as the node issued them (the decrypted saved
  artifact before any profile);
- `settings`: the resolved settings with their sources (`profileFrom`,
  `mtuFrom`, the preset id or `null` for issued), plus the key's device type
  and owner id, so the dialog can offer the pins.

Parameters are a whitelist, in this order: `Jc`, `Jmin`, `Jmax`, `S1`-`S4`,
`H1`-`H4`, `I1`-`I5`, `ContentPaddingAddition`, `RekeyAfterTime`,
`RekeyTimeout`, `RejectAfterTime`, `KeepaliveTimeout`, `MaxHandshakeAttempts`,
`MTU`. Each entry is `{ name, value | null, scope: "client" | "server" }`
(`server` for S and H). Private, preshared and header-protection keys,
addresses, DNS, endpoints and allowed IPs never leave the server. A non-3.1
key answers `409 AWG_GENERATOR_UNSUPPORTED`; an unknown key `404`.

`GET /api/admin/nodes/:id/client-parameters?endpointId=<uuid>` returns the
same shape for a node address (or the node when no address is named), built
from that node's service-account key (the probe's newest unrevoked AWG 3.1 key
on the node, the one the probe measures) with only the address and node
levels, i.e. what the probe measures; without `endpointId` only the node
level applies. Address device rules are not applied (the service key has no
device type). Without such a key it answers `404 SAMPLE_KEY_NOT_FOUND` and
the UI says the node has no service key yet (no probe registered or not run).

### Per-user device rules

`users.awg_device_rules` (jsonb, nullable, same schema as the address rules).
`users/set-config` accepts `awgDeviceRules` (`null` clears all; an object
replaces the whole map, last write wins), alongside `awgGenerator` and
`awgMtu`; audited under the same `admin.users.set-config` event, whose
metadata now includes the device rules. Keys reject `awgDeviceRules`.

### Pin

`POST /api/admin/keys/:id/pin-config` with `{ target: "user" | "device" }`
resolves the key's settings on the server inside a transaction and writes:

- `user`: the owner's `awgGenerator` and `awgMtu` become the key's effective
  profile and MTU;
- `device`: the owner's rule for the key's device type becomes them (other
  types untouched).

A pin always writes both fields, as concrete values, so it holds against any
later node or address edit (calls ruled by the author, 2026-11-22):

- the profile "as issued by the node" (no generator anywhere) pins as the
  `issued` preset;
- an MTU that resolves from the profile or the 1280 default pins as that
  number;
- a value that comes from the key's own override is copied too (the pin
  means "the owner's keys get what this key gets"); the dialog says so;
- whatever the target held before is replaced, and the confirm step shows it.

Pinning `user` while the owner has rules for some device types leaves those
rules in place, and the dialog notes that keys of those types keep their
rule. Pinning `device` when that rule already holds the same values succeeds
without change. Refused with `409 PIN_UNAVAILABLE` for a non-3.1 key, a
service-account owner, or `device` with device type `unspecified`. Audited
as `admin.keys.pin-config` with the target and the written settings.

### UI (admin)

- **Parameters dialog**, opened from a key row (users page) and from each
  address and the node in the node config dialog: a compact two-column table
  per group (J, S/H marked "server", I packets, CPA and timings, MTU) with the
  exported value and, when it differs, the issued one; long I templates wrap
  in a monospace cell with a copy button. A header line names the profile and
  MTU with their source badges (the existing source labels). Loading,
  error and "no service key" states.
- In the key's parameters dialog: "Pin for the user" and "Pin for the user's
  <device type> devices" buttons, each with a confirm step that shows what it
  replaces when the user already has a setting there.
- **User config dialog** gains the device-rules editor (the address editor
  reused) and a "Now in effect" list of the user's AWG 3.1 keys: name, device
  type, profile and MTU with source badges, a button to the key's parameters.
- New strings in ru and en; styling with the existing components and tokens.

### CLI

- `config-presets` — preset ids, labels and descriptions.
- `config-show node <id> | address <endpoint-id> | user <id|email> | key <id>`
  — what the level sets (profile, MTU, device rules) and, for a key, what
  resolves and from where.
- `config-set <level> <id> [--preset=<id>|--profile=inherit]
  [--randomize=true|false] [--mtu=<1280-1420>|--mtu=inherit]
  [--settings-file=<path|->] [--device=<type>] [--clear]` — sets the level's
  profile/MTU; with `--device` it edits that device type's rule at an address
  or user level (`--clear` removes the rule); `--settings-file` takes full
  generator settings as JSON (Custom) and excludes `--preset` and
  `--randomize`. `--device` is valid only at the address and user levels;
  `user` accepts an id or the email of a person (not the service account).
- `config-params key <id> | node <id> [--endpoint=<uuid>] [--json]` — the
  parameters view.
- `config-pin <key-id> --to=user|device` — the pin.
- `user-create-key` gains `--preset=` and `--mtu=`.
- Usage text, `docs/CLI.md`.

## Constraints

Stored settings stay valid; migrations are additive. No real names or
addresses in code, tests or docs; English comments; commits to `main` by
wyrtensi. Admin-only: no user-facing response gains any of this.

## Approaches considered

- Pin exact values (new frozen profile type) vs copy profile settings: the
  administrator chose copying settings.
- Pin composed in the browser from the key row vs on the server: on the
  server, so the resolved settings are the ones the export uses and the
  device-rule merge cannot race another edit.
- Parameters parsed in the browser from a downloaded config vs a dedicated
  endpoint: a dedicated endpoint, so secrets never reach the page and no
  export is recorded.

## Left to the builder

Layout details of the dialogs, CLI output formatting, exact copy.
