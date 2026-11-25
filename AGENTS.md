# Agent instructions for this fork

Read [CLAUDE.md](CLAUDE.md), [CONTRIBUTING.md](CONTRIBUTING.md) and [IMPLEMENTATION.md](IMPLEMENTATION.md) before making changes. Upstream architecture, coding standards and licensing remain authoritative. This file narrows the scope of work; it does not replace upstream instructions.

## Working principles

- Complete Crossmart as Crossmart. Use its existing modules, connector SDK, API contracts, catalog, agent, queues, security and UI. Do not redesign or migrate another platform into it.
- The scope is Odoo 18 as a source integration, WooCommerce as a native channel and completion of the existing Mercado Libre connector for Ecuador. Dropshipping and additional channels are out of scope.
- Previous implementations are reference material only; do not import entire modules, private source, credentials, schemas, architecture or tests. Check rights before copying any code into this public fork.
- Use the native content generator first. Evaluate real commercial copy before adding research or model-provider support. No new agent framework, standalone media manager, memory system or speculative abstractions.
- Work on one phase and a dedicated branch at a time. Keep changes small and consistent with upstream. Preserve existing tests and follow upstream verification commands; add focused regression tests only as needed.
- A passing test is not proof of an operational feature. Distinguish mock, integration, browser and live-provider evidence. Never invent success or hide failures. Report exact blockers, changed files and reproduction steps.
- Keep both Crossmart repositories and their runtime fully isolated from other applications. Use separate database, Redis, Docker project, networks, volumes, ports, credentials and working directories. Inspect existing allocations before starting. Never reset or remove another environment, and never use production credentials or data for setup.
- Do not commit secrets, customer data, private URLs, product data, private-source excerpts or deployment-specific configuration. Keep `.env` files local and ignored. Do not expose a test service publicly by default.
- No production writes, real listings, real orders or destructive operations without explicit authorization for that operation. Use staging, drafts or sandbox where supported. Never bypass security or marketplace rules.
- Update the status in IMPLEMENTATION.md only with evidence. No extra planning documents unless an upstream convention or concrete technical need requires one.

Code, commits and repository documentation are in English, as required upstream.
