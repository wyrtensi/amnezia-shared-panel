# Client MTU on its own, and configuration profiles per user and per key

Status: approved in conversation 2026-11-21. Builds on
`docs/AWG-GENERATOR.md` and the reachability probe design
(`2026-11-21-probe-per-address-verdicts-design.md`).

## Intent

Administrators want to try other AWG 3.1 client settings on real devices
before rolling them out to a node, and to give a few special users settings
that differ from their server's (a provider that breaks the default). Today
the configuration profile (`awgGenerator`) lives on the node and on each
registered address only, and the client MTU is a field inside that profile:

- with no profile ("inherit defaults", every node and address in production)
  the MTU is fixed at 1280 and the editor shows no MTU field;
- an address that inherits its node's profile cannot change only its MTU: it
  has to take a profile of its own and stops following the node.

## Goals

- **Client MTU is its own setting**, independent of the profile, on the node
  and on each address. Each level either inherits or sets a number
  (1280-1420). A node can stay on "inherit defaults" and still get MTU 1380.
- **Per-user settings**: an administrator can give a user a profile and/or an
  MTU that apply to every AWG 3.1 key of that user, whatever node or address
  the key is on.
- **Per-key settings**: an administrator can give one key a profile and/or an
  MTU, when issuing it (to a user from the admin panel, or to themselves in
  the cabinet) and later on an existing key.
- **Per-device-type settings on each address**: an administrator can give an
  address a profile and/or an MTU for one device type (Android, iOS, macOS,
  Windows, Linux, other) that apply to that address's keys of that type.
  A key's device type is chosen when it is issued and never changes;
  "unspecified" matches no rule.
- Only administrators see or change user, key and device-type settings, like
  key bridge modes (the administrator's rule: bridge and similar details stay
  admin-only).

## Non-goals

- AWG 2.0 keys: no client profile; the settings do not apply to them.
- The reachability probe does not measure user, key or device-type settings;
  it keeps measuring what an address's ordinary users get (the
  administrator's choice for device-type rules).
- No automatic "re-import your config" message to users; existing behaviour
  (settings apply to the next export, devices import again) stays.
- No new MTU limits; the operator doc's MTU and FRP notes still apply.

## Behaviour

### Precedence

For an AWG 3.1 key, every export (and config refresh) resolves:

- **Profile**: the key's own, else its owner's, else its address's rule for
  the key's device type, else its address's, else its node's, else none (the
  issued artifact and saved client profile, as today).
- **MTU**: the first set of the key's MTU, the owner's, the address's rule for
  the key's device type, the address's, the node's; if none is set, the MTU
  stored inside the resolved profile; if there is no profile either, 1280.
- A special user's settings win over device-type rules: they are set for that
  person on purpose. (My call.)
- The resolved MTU is applied after the profile, and the per-key values a
  randomized profile draws (Jc, Jmin, Jmax, signature packets) come from the
  stored profile alone, so changing an MTU anywhere never moves them. (Builder
  check; my call.)

The address is the key's `endpointId`, or the node's primary address when the
key has none, as today. One resolver in shared code computes both values and
is used by every caller that resolves the effective profile today (exports,
config refresh and its token, the key read model, the probe's projection and
the bridge candidate check), so they cannot drift.

### Storage

- `nodes.awg_mtu`, `node_vpn_endpoints.awg_mtu`, `users.awg_mtu`,
  `vpn_keys.awg_mtu`: nullable integers, null = inherit.
- `users.awg_generator`, `vpn_keys.awg_generator`: nullable profile JSON
  validated by `awgGeneratorSettingsSchema`, null = inherit.
- `node_vpn_endpoints.awg_device_rules`: per device type, an optional profile
  and an optional MTU; an empty rule is not stored.
- Migration: every node and address with a saved profile gets that profile's
  MTU as its own MTU, so every level keeps exactly the MTU it has today (an
  address with its own profile at 1280 under a node at 1400 stays at 1280).
  The profile's `mtu` field stays in the schema for API compatibility; API
  clients set the separate MTU. (Builder check; my call.)

### Admin UI

- **Node and address editors**: the profile select as today plus a separate
  "Client MTU" control: "inherit" (showing the inherited value) or a number.
  The MTU field leaves the profile part of the form.
- **Address editor, device types**: one row per device type with a rule
  (profile and MTU controls), and "add a rule for a device type".
- **User page (admin)**: a "Configuration settings" block with the same two
  controls, inheriting from the user's server.
- Every profile control is the existing profile editor (`GeneratorEditor`),
  Custom included: tests on real devices need it. (Builder check; my call.)
- Convenience and style (the administrator asked for both): every control
  sits next to what it changes and says where its value comes from when it
  inherits ("inherited from the server: 1280", "inherited from the user:
  STUN"); a key's card shows its effective profile and MTU and which level
  set them; a control that is set can be reset to inherit in one click.
  Every new control uses the panel's shared components (`Select`, `Switch`,
  `Dialog`, `Badge`, the profile editor) and theme tokens, so it matches the
  rest of the admin UI in light and dark themes and at phone width.
- **Key issue dialogs**: the admin's create-key dialog for a user and the
  cabinet create-key wizard (shown only to administrators, AWG 3.1 only)
  get the same two controls, defaulting to inherit.
- **Existing keys (admin)**: the key row in the admin user page gets an action
  to change the key's profile and MTU, with a note that the device must import
  the config again. Keys with their own or their owner's settings show a small
  admin-only marker ("own settings, not checked by the probe").

### Changes and their effects

- Saving user or key settings applies to the next export. The key's saved
  client profile (`awgClientProfile`) is untouched, so randomized presets
  draw per key exactly as on an address.
- Config refresh eligibility and its token use the resolved profile and MTU.
- A node or address MTU change is a change to what the probe measures: it
  resets that evidence and queues a probe run like a profile change does
  (`2026-11-21-probe-recheck-on-config-change-design.md`). User and key
  changes do not touch the probe.
- The probe does not measure device-type rules either (the administrator's
  choice): it keeps measuring an address's ordinary config. A device-type rule
  shows an admin-only "not checked by the probe" note, like user and key
  settings. A device-type rule change queues no probe run.
- Every change is audited (`admin.users.set-config`, `vpn_key.config_set`,
  node, address and device-type changes through the existing node update
  audit), with the preset id and MTU, never config contents.
- Settings on an AWG 2.0 key are refused (409); a user's settings simply do
  not affect their AWG 2.0 keys.

## Approaches considered

1. **Separate MTU chain plus profile overrides on user and key** (chosen): one
   resolver, two independent inheritance chains.
2. Keep MTU inside the profile and let a level inherit the profile while
   overriding only its MTU: partial profile objects, and every level would
   still need the same split for keys and users.
3. Per-user only: covers special users but not tests, which need different
   settings on keys of one account.

## Constraints

- Admin-only everywhere: the user API and cabinet views never expose user or
  key settings.
- No names, IPs or hostnames of real installations in code, tests or docs.
  Comments in English. Commits to `main`, author wyrtensi, no Co-Authored-By.

## Left to the builder

Column and action names, the resolver's location and signature, the exact UI
wording and layout of the controls and marker.
