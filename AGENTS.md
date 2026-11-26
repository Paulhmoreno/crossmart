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

## Permanent interface and localization rules

- The companion frontend AGENTS.md defines the mandatory UI standard: faithful upstream Crossmart design, English canonical interface language with centralized English and Spanish (Ecuador) translations, and concise non-intrusive copy. Follow it for every new integration.
- Keep machine-readable identifiers, API contracts and technical diagnostics stable and in English. Localize operator-visible messages through the shared UI translation mechanism, using stable error codes or narrowly scoped mappings as needed. Do not hard-code a second language in backend responses or change existing API semantics just to translate a label.
- Keep commercial product content and agent output language separate from the interface locale. Do not regenerate or translate saved product content on a UI language change.
- Never remove validation, authorization, meaningful errors or ERP source ownership protections during visual cleanup. Do not build extra UI explanations for backend safeguards.
- Settings screens must be limited to configuring services and integrations, without duplicating operational modules, product listings, or dashboards.
- Channel cards in Stores (including WooCommerce, Mercado Libre, and future integrations) must use brief single-sentence descriptions matching native channels, visually balanced official logos inside the native container, and identical shared card structure.
- Keep operational self-hosted features strictly separate from SaaS commercial surfaces. Use native `BILLING_DRIVER=none` and `ENTITLEMENTS_ENFORCED=false` for self-hosted operation; keep backend billing modules, models, and contracts intact while hiding commercial billing, SaaS support escalations, marketplace request links, and incomplete connector previews from the operational UI. All future implementations must respect upstream design, centralized i18n, and the self-hosted context.

Code, commits and repository documentation are in English, as required upstream.
