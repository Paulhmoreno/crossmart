# Implementation plan

## Scope and ownership

Self-hosted Crossmart, preserving the upstream backend and web architecture. Odoo 18 is authoritative for product identity, SKU, barcode, variants, base price, available stock and original product photographs/documents. Crossmart owns commercial content, channel-specific adaptations, listings and operational status. Existing Crossmart media facilities handle copies for publication; no separate media manager.

Odoo integration must use its supported API with a least-privilege read-only account. Read the product Documents relation and its authorized attachments; classify publication images separately from manuals and other internal files. Verify actual models, permissions and media retrieval before designing the integration. Keep private source files private. Preserve commercial edits during sync and prevent duplicate products, duplicate inventory changes and unintended Odoo writes.

## Phases

| Phase | Scope | Acceptance | Status |
| --- | --- | --- | --- |
| 0 | Unmodified Crossmart backend and web in an isolated local environment | API health, worker and database/Redis connected; browser registration/sign-in and demo catalog, product editor, agent console and channel pages inspected. Record errors and actual statuses. | Not started |
| 1 | Odoo source connector | Read-only connection; three representative products (known barcode, generic, variants); price/stock, identity and attached image/document retrieval; repeat sync without duplicates or overwriting commercial content. | Not started |
| 2 | Native WooCommerce connector | Follow the existing channel SDK; verify connection, taxonomy, draft/authorized test listing, images, content, price and stock against a test store; verify remote persisted result and storefront where applicable. | Not started |
| 3 | Native commercial agent | Evaluate real Spanish-language copy for representative products, including missing data. Useful copy without invented specifications. Only add narrowly scoped research or provider support if the native flow demonstrably needs it. | Not started |
| 4 | Mercado Libre Ecuador | Extend the existing connector, verify site/auth and real category/attribute requirements; validate an authorized test listing, inventory and price. Do not assume fixture success means live readiness. | Not started |
| 5 | Listing monitoring and correction | Observe actual item/moderation events, retrieve authoritative status, correct eligible issues with bounded retries, escalate unsafe or unresolved issues. Verify no duplicate listings or unauthorized deletes. | Not started |
| 6 | End-to-end commercial operation | Import from Odoo, inspect media and copy, publish to authorized test channels, check remote results and sync updates. Operator accepts the actual experience and content. | Not started |

## Current mission: phase 0 only

Use the upstream README quick-start instructions and existing tooling. No functional implementation, schema changes, new services, UI redesign, or provider changes in this phase. Use a clean sibling checkout of both forks, not a previous project directory. Keep original upstream remotes and record the exact tested commit of each checkout.

Before starting services, inspect local running processes/containers and ports; choose unused loopback ports and a unique Docker Compose project name. Use isolated database and Redis credentials, new volumes, and consistent API/auth/media/CORS/frontend URLs. Check the effective Compose configuration without revealing secrets. Use demo data only. Do not connect Odoo or any real marketplace. Do not delete or stop unrelated services.

Follow upstream validation instructions. If a command fails, diagnose the concrete failure, do not introduce speculative refactors. Report: tested commits, local URLs, running components, actual browser workflow results, errors or missing credentials, and whether phase 0 is complete. Do not claim browser validation without opening the browser; do not claim agent generation works without an actual configured-provider run. Missing optional AI credentials may be recorded as a limitation, not a fake success. Stop after phase 0 and report before expanding scope.

## Completion policy

The next phase begins after the current functional result is checked. Keep the original documentation and conventions. No additional channels or dropshipping. Prefer observed outcomes over test counts. Only publish generic, non-sensitive evidence in public repositories; keep environment details and business data in private local records.
