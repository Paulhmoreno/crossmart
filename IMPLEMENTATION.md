# Implementation plan

## Scope and ownership

Self-hosted Crossmart, preserving the upstream backend and web architecture. Odoo 18 is authoritative for product identity, SKU, barcode, variants, base price, available stock and original product photographs/documents. Crossmart owns commercial content, channel-specific adaptations, listings and operational status. Existing Crossmart media facilities handle copies for publication; no separate media manager.

Odoo integration must use its supported API with a least-privilege read-only account. Read the product Documents relation and its authorized attachments; classify publication images separately from manuals and other internal files. Verify actual models, permissions and media retrieval before designing the integration. Keep private source files private. Preserve commercial edits during sync and prevent duplicate products, duplicate inventory changes and unintended Odoo writes.

## Phases

| Phase | Scope | Acceptance | Status |
| --- | --- | --- | --- |
| 0 | Unmodified Crossmart backend and web in an isolated local environment | API health, worker and database/Redis connected; browser registration/sign-in and demo catalog, product editor, agent console and channel pages inspected. Record errors and actual statuses. | Completion reported by operator; independent browser review pending |
| 1 | Odoo source connector | Single-screen read-only connection; three representative products (known barcode, generic, variants); price/stock, identity and attached image/document retrieval; repeat sync without duplicates or overwriting commercial content; enforce source-owned fields in API and UI while manual products stay editable. | Not started |
| 2 | Native WooCommerce connector | Follow the existing channel SDK; verify connection, taxonomy, draft/authorized test listing, images, content, price and stock against a test store; verify remote persisted result and storefront where applicable. | Not started |
| 3 | Native commercial agent | Evaluate real Spanish-language copy for representative products, including missing data. Useful copy without invented specifications. Only add narrowly scoped research or provider support if the native flow demonstrably needs it. | Not started |
| 4 | Mercado Libre Ecuador | Extend the existing connector, verify site/auth and real category/attribute requirements; validate an authorized test listing, inventory and price. Do not assume fixture success means live readiness. | Not started |
| 5 | Listing monitoring and correction | Observe actual item/moderation events, retrieve authoritative status, correct eligible issues with bounded retries, escalate unsafe or unresolved issues. Verify no duplicate listings or unauthorized deletes. | Not started |
| 6 | End-to-end commercial operation | Import from Odoo, inspect media and copy, publish to authorized test channels, check remote results and sync updates. Operator accepts the actual experience and content. | Not started |

## Current mission: phase 1 only

Phase 0 completion was reported by the operator; do not reinstall or reset the existing isolated Windows lab. Preserve the working environment and check the current Git status before branching. Use a dedicated `feat/odoo` branch in each repository where changes are required. Do not overwrite uncommitted work.

- Build a source integration using existing Crossmart patterns for configuration, encrypted credentials, API, background jobs, catalog and activity. Consult the previous Odoo adapter as a private reference only; do not port its architecture or publish private source. Use a single connection screen (URL, database, user, API key, test/connect); standard mapping automatically, optional advanced settings only when required by actual data. No wizard or mandatory multi-stage onboarding.
- Use Odoo 18 read-only API access. Identify products/variants by stable source identifiers scoped to the connection; SKU alone is not a durable source identity. Discover actual fields and product Documents/attachments with the live account. Import only explicitly selected test products initially. Copy eligible images through native media facilities; keep technical/internal documents private and never publish arbitrary attachments or make Odoo public. No live Odoo writes.
- Record source ownership per product/variant, not globally. Protect source identity, SKU, barcode, variant identity, base price, stock and original media from manual, bulk, import and agent edits through server-side enforcement; show source and field-level read-only indicators in the existing editor. Keep commercial title/description/tags, channel settings and channel overrides editable. Manual catalog products remain fully supported. Prevent accidental delete/recreate or detachment of linked products. Preserve commercial edits and stable identities during repeat sync.
- Respect the native inventory ledger; use its supported reconciliation semantics. Do not double-count orders or stock changes. Do not connect live sales channels in this phase. Verify stock definition, currency, variant price, warehouse and pricelist as applicable to the real source; do not assume every Odoo deployment uses the same mappings. Show connection status, last sync, counts and actionable errors using native UI.
- User-facing interface and commercial output should support Spanish (Ecuador). For phase 1, translate the new integration and its relevant product feedback, keeping the existing visual design. Inspect upstream localization conventions; if there is no existing mechanism, propose a small incremental localization plan for existing UI after phase 1, rather than performing a broad rewrite. Keep code, identifiers, commits and repository documentation in English.
- Test on three representative real source products using a read-only account and isolated Crossmart database. Verify initial and repeated sync, no duplicates, correct field ownership through UI and API, editable commercial fields, manual product creation, images, restricted documents and failure states. Do not log secrets or private product/customer data in public Git history. If a required credential is unavailable, report the blocker instead of fabricating successful live tests.
- Stop after phase 1. Report actual browser and API results and changes, not test counts alone. Do not implement WooCommerce, Mercado Libre, customer messaging or general localization in this phase.

## Later phases: design constraints

WooCommerce: retain upstream connector SDK and simple credential-based setup; consult the prior working implementation and official REST API as references. Reuse only rights-cleared code where it fits natively. Check persisted and visible results, including images and taxonomy.

Mercado Libre: extend the existing native connector rather than replacing it. Compare official [API validation](https://developers.mercadolibre.com.ec/validaciones), [category/attribute rules](https://developers.mercadolibre.com.ec/categorias-y-atributos), [notifications](https://developers.mercadolibre.com.ec/productos-recibe-notificaciones) and [moderations](https://developers.mercadolibre.com.ec/gestionar-moderaciones) with the native connector and community references [fedeclavero/mercadolibre-mcp](https://github.com/fedeclavero/mercadolibre-mcp), [dedero1985/mercadolibre-mcp](https://github.com/dedero1985/mercadolibre-mcp) and [matuck40/mercadolivre-mcp](https://github.com/matuck40/mercadolivre-mcp). Treat these as references, not dependencies or proof of Ecuador support. Verify MEC behavior and live authorization; use official rules for allowed corrections, do not automatically relist prohibited items.

Customer-facing sales agent: separate future evaluation, not part of this mission. Crossmart's native operator agent and catalog API/MCP may serve as product knowledge; do not rebuild a customer inbox or expose internal agent permissions to buyers. Evaluate a self-hosted inbox such as Chatwoot and channel-specific messaging APIs separately. Mercado Libre questions and post-sale messaging must respect channel rules. No implementation until explicitly scoped.

## Completion policy

The next phase begins after the current functional result is checked. Keep the original documentation and conventions. No additional channels or dropshipping. Prefer observed outcomes over test counts. Only publish generic, non-sensitive evidence in public repositories; keep environment details and business data in private local records.
