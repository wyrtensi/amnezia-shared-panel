# Third-Party Notices and Attributions

This project (**amnezia-remote-panel**) incorporates and builds upon third-party
software. This file records the required attributions and the licenses of the
notable components. Nothing here changes the terms of any third-party license;
each dependency remains governed by its own license as distributed with that
package.

---

> ## LICENSE CHOICE PENDING OWNER CONFIRMATION
>
> The bundled `services/node-agent` component is a fork of
> [`kyoresuas/amnezia-api`](https://github.com/kyoresuas/amnezia-api), distributed
> under the **MIT License** (see the quoted notice below and
> `services/node-agent/LICENSE`).
>
> **MIT is permissive and imposes no copyleft obligation.** There is therefore
> **no GPL / copyleft constraint** forcing a particular license on this combined
> work. The only requirement inherited from the fork is that the upstream MIT
> copyright and permission notice be preserved in distributions — which this file
> and the retained `services/node-agent/LICENSE` satisfy.
>
> The repository ships a default root [`LICENSE`](LICENSE) that is **MIT,
> `Copyright (c) 2026 wyrtensi`**. Choosing the project's own outbound license is
> the owner's decision. Before the public release, **confirm** that MIT is the
> intended license for your own code. MIT is compatible with the MIT-licensed
> vendored fork, so no compatibility blocker exists — this flag is only to prompt
> an explicit owner decision, not to report a conflict.

---

## 1. Vendored component — `services/node-agent`

`services/node-agent` is a reviewed fork of
[`kyoresuas/amnezia-api`](https://github.com/kyoresuas/amnezia-api), a self-hosted
REST API for automating Amnezia VPN servers. It was brought into this repository
(vendored) and adapted for use as this project's per-node agent.

- **Upstream project:** kyoresuas/amnezia-api
- **Upstream author:** Kyoresuas
- **License:** MIT
- **Retained license file:** `services/node-agent/LICENSE`

The upstream `LICENSE`, reproduced verbatim in `services/node-agent/LICENSE`,
reads:

> MIT License
>
> Copyright (c) 2025 Kyoresuas
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Please keep `services/node-agent/LICENSE` in place so the upstream attribution
travels with any distribution of this repository.

## 2. Underlying VPN technology — AmneziaWG / Amnezia ecosystem

This project manages and interoperates with the **AmneziaWG** protocol and the
broader **Amnezia VPN** ecosystem
([amnezia-vpn](https://github.com/amnezia-vpn)), including components such as
`amneziawg-go`, `amneziawg-tools`, and the AmneziaVPN clients. AmneziaWG is a
fork of / derived from **WireGuard**.

This repository does **not** vendor the AmneziaWG or WireGuard source code; the
node agent orchestrates Amnezia's existing containers and tooling that are
installed and run on each VPN node. The credit below is an acknowledgement of the
technology this project builds on, not a redistribution of it.

- **AmneziaWG / Amnezia VPN** — maintained by the Amnezia team.
- **WireGuard** — "WireGuard" is a registered trademark of Jason A. Donenfeld.

This is an independent community project. It is **not** affiliated with,
sponsored by, or endorsed by the Amnezia project, WireGuard LLC, or Jason A.
Donenfeld.

## 3. Notable third-party libraries

The following notable direct dependencies are used across the workspace. License
identifiers are taken from each package's own metadata as installed. This is a
curated list of the significant components, not an exhaustive enumeration of the
full transitive dependency tree. Each library's full license text ships inside
its own package (and on its registry/repository page).

### Web application (`apps/web`)

| Library | License |
| --- | --- |
| next (Next.js) | MIT |
| react, react-dom | MIT |
| @radix-ui/react-* (Radix UI primitives) | MIT |
| shadcn/ui (generated components in `components/ui`, built on Radix UI) | MIT |
| lucide-react | ISC |
| next-themes | MIT |
| sonner | MIT |
| class-variance-authority | Apache-2.0 |
| clsx | MIT |
| tailwind-merge | MIT |
| tailwindcss, @tailwindcss/postcss | MIT |
| tw-animate-css | MIT |

### Control API (`apps/control-api`)

| Library | License |
| --- | --- |
| fastify | MIT |
| @fastify/helmet | MIT |
| drizzle-orm | Apache-2.0 |
| jose | MIT |
| qrcode | MIT |
| zod | MIT |

### Worker (`apps/worker`)

| Library | License |
| --- | --- |
| drizzle-orm | Apache-2.0 |
| zod | MIT |

### Database package (`packages/db`)

| Library | License |
| --- | --- |
| drizzle-orm | Apache-2.0 |
| postgres (porsager/postgres) | Unlicense (public domain) |
| drizzle-kit | MIT |

### Contracts package (`packages/contracts`)

| Library | License |
| --- | --- |
| zod | MIT |

### Node agent (`services/node-agent`) — notable direct dependencies

The forked node agent (MIT, see section 1) additionally depends on the following
notable libraries:

| Library | License |
| --- | --- |
| fastify, @fastify/* (cookie, cors, formbody, helmet, rate-limit, swagger, swagger-ui, type-provider-json-schema-to-ts) | MIT |
| fastify-metrics | MIT |
| awilix | MIT |
| awilix-manager | MIT |
| winston | MIT |
| i18next, i18next-http-middleware | MIT |
| node-cron | ISC |
| qrcode | MIT |
| uuid | MIT |
| chalk | MIT |
| ipaddr.js | MIT |
| ajv-errors | MIT |
| dotenv | BSD-2-Clause |
| cross-env | MIT |

---

*If you redistribute this project, keep this NOTICE.md together with the root
`LICENSE` and `services/node-agent/LICENSE` so that all attributions remain
intact.*
