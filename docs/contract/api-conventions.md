# getproperty API Contract Conventions (v1) (shared by `getproperty-api`, `getproperty-web`, `getproperty-liff` and `getproperty-edge`)

> This file is **identical in all four repositories** (`docs/contract/api-conventions.md`). Change it only by a PR to every repo on the same day. The backend owns the contract; the web app, the LIFF app and the edge agent consume it. The MQTT device protocol has its own document, `docs/contract/device-protocol.md` (D-130), owned by the backend too.
> Derived from the getpack conventions v3; differences are the surfaces (§2), the device surface (§7) and tenancy scoping (§8).
> **Vocabulary (D-151, ADR-0009):** a **tenant** is the SaaS customer organisation (`tenant.type` = `apartment | condo_juristic | pm_company | landlord`) — never the person who rents. People are **parties**; a person living in a unit is a **resident** (lessee, co-occupant, condo owner); the people working for a tenant are **operators**; external contractors are **technicians**.

## 1. Ownership & flow
- `getproperty-api` is the **single source of truth** for every endpoint, DTO and enum. The OpenAPI 3.1 document is generated from code (`@nestjs/swagger`) by `pnpm contract:build` (boots the Nest app without listening, writes `contract/openapi.json`) and **committed** in the backend repo.
- Backend CI: regenerates the file and fails if it differs from the committed one (`contract drift`); runs `oasdiff breaking` against `main` — a breaking change fails CI unless the PR has label `contract:breaking` **and** the change goes to a new version prefix or is coordinated with a frontend/LIFF/edge PR (linked in the description).
- Each backend release tag `vX.Y.Z` publishes `contract/openapi.json` and `contract/device-protocol.json` (JSON Schemas of the MQTT payloads) as release assets.
- `getproperty-web` and `getproperty-liff` run `pnpm gen:api`, which reads `API_CONTRACT_SOURCE` (default `../getproperty-api/contract/openapi.json` for local sibling checkouts; CI uses the release asset URL of the pinned version in `contract.lock.json`) and writes `src/lib/api/schema.d.ts` with `openapi-typescript`. `getproperty-edge` runs `pnpm gen:protocol` the same way for the device payload types. Generated files are committed; CI regenerates and fails on drift.
- Frontends can work ahead of the backend using a mock server generated from the same contract (MSW handlers from `openapi.json`). A feature is "done" only when it passes against the real backend in the integration environment.

## 2. Surfaces & prefixes
| Prefix | Consumer | Token audience |
|---|---|---|
| `/v1/auth/*` | all | issues tokens |
| `/v1/owner/*` | owner console of `getproperty-web` (Owner, Manager, Accountant and Staff roles of a tenant, D-090; PM/landlord portfolio views later) | `operator` (scoped to one or more `tenant:<uuid>`) |
| `/v1/staff/*` | staff PWA of `getproperty-web` (readings, inspections, installs, service requests, parcels) — same `operator` audience with the Staff role; split as a prefix so the PWA's allow-list stays narrow | `operator` |
| `/v1/resident/*` | `getproperty-liff` resident pages (LINE Mini App, with a mobile-web fallback; D-060, D-154): lessees, co-occupants, condo owners | `resident` (scoped to `lease:<uuid>` / `unit:<uuid>` lists) |
| `/v1/technician/*` | `getproperty-liff` technician pages: external technicians and contractors (R2; placeholder until B5) | `technician` (scoped to `work_order:<uuid>` list) |
| `/v1/admin/*` | platform admin zone of `getproperty-web` (Collective Group staff: tenants, subscriptions, device fleet, tariffs, support, AI usage cost) | `platform` |
| `/v1/device/*` | gateways (`getproperty-edge`) over HTTPS for provisioning, bootstrap, OTA manifests and large uploads; telemetry itself goes over MQTT (D-130) | `device` (mTLS client certificate; a short-lived JWT is minted at bootstrap) |
| `/webhooks/*` | payment gateways / banks, slip verification, LINE Messaging, lock vendors, e-Tax provider — signature-verified | none |
| `/v1/public/*` | marketing pages of `getproperty-web` (price plans, the published tariff ceiling) — anonymous, cacheable, never personal data | none |
| `/health`, `/docs`, `/docs-json` | ops | none (docs disabled in prod unless `DOCS_ENABLED`) |

A token issued for one audience is rejected on every other prefix (guard checks `aud`). OpenAPI tags are prefixed by surface (`owner.invoices`, `resident.invoices`, `admin.devices`…) so generated types are easy to navigate. Security schemes: `operatorBearer`, `residentBearer`, `technicianBearer`, `platformBearer`, `deviceBearer`.

## 3. Resource & payload rules
- JSON keys `camelCase`. Resource nouns, plural, named after the schema entities (D-151): `GET /v1/owner/buildings/{buildingId}/units`, `GET /v1/owner/invoices/{invoiceId}`. Actions that are not CRUD: `POST /v1/owner/invoices/{invoiceId}/actions/{action-name}` (`issue`, `void`, `send-reminder`).
- **IDs**: every row's primary key is a `uuid` (UUIDv7, schema-design v2 §1.2); that id is what URLs, payloads, tokens and cursors carry — there is no second internal id. Human business keys (`invoiceNumber`, `receiptNumber`, `unitNo`, `deviceSerial`) are returned as separate fields and may be used for search, not as path ids (exception: `GET /v1/resident/invoices/by-number/{invoiceNumber}` for LINE deep links and `GET /v1/device/by-serial/{serial}` at provisioning).
- **Money**: decimal **string** with exactly 2 decimals, e.g. `"1234.50"`, plus `currency: "THB"` at the object level where money appears. Never JSON numbers for money. Clients never perform price arithmetic; they only format values the API returns. (D-046)
- **Meter quantities**: `register` and `units` are decimal strings with up to 3 decimals (`"12345.678"`), `unit` is an enum (`kwh`, `m3`); tariff and rate-plan `pricePerUnit` is a decimal string with up to 4 decimals.
- **Date-times**: ISO 8601 with offset (`2026-11-01T00:00:00+07:00`), stored UTC, rendered by the API in `Asia/Bangkok` offset. Date-only fields `YYYY-MM-DD`. Business-day and billing-cycle maths is **backend-only**.
- **Enums**: string enums in `snake_case` (`partially_paid`, `condo_juristic`). Each enum is a named OpenAPI component (`InvoiceStatus`, `LeaseStatus`, `ReadingSource`, `DeviceStatus`, `TenantType`, `UnitType`, `InvoiceLineSourceType`, …) so clients import it by name.
- **Lists**: `GET ...?page=1&perPage=25&sort=createdAt&order=desc&q=...&<filters>` → `{ "data": [...], "meta": { "page": 1, "perPage": 25, "total": 1234 } }`. `perPage` max 100. Feeds, telemetry and event logs use cursors: `?cursor=...&limit=50` → `{ "data": [...], "meta": { "nextCursor": "..." | null } }`. Telemetry series endpoints take `from`, `to`, `bucket` (`15m | 1h | 1d`).
- **Errors**: RFC 9457 problem details, `Content-Type: application/problem+json`:
  `{ "type": "https://errors.getproperty.co/<code>", "title": "...", "status": 422, "code": "invoice.invalid_transition", "detail": "<Thai message>", "errors": [{ "path": "lines[1].pricePerUnit", "code": "max", "message": "..." }], "requestId": "..." }`. `code` is stable and machine-readable; `detail`/`message` are localised by `Accept-Language` (`th` default, `en`, resident surface also `my|km|lo|zh` in R2). Compliance refusals use the `compliance.*` code family and carry `legalRef`; compliance **warnings** that need an acknowledgement (D-021a `compliance.tariff_cap` at severity `warn`) are returned as `409 compliance.acknowledgement_required` with the warning text and the values shown, and the client repeats the request with the acknowledgement id.
- **Idempotency**: every irreversible `POST` (invoice issue, payment record, refund, credit note, deposit settlement refund, lease signature, device provisioning, subscription changes, reading submission from staff) requires header `Idempotency-Key` (uuid). Replays within 24 h return the original response.
- **Concurrency**: editable aggregates (lease, unit, building, rate plans, tenant settings) return `ETag`; updates send `If-Match`; mismatch → `412` problem `concurrency.stale`.
- **Files**: `POST .../files/presign` → `{ uploadUrl, fileId, headers, expiresAt }`, client PUTs to object storage, then references `fileId` (a `core.document` id). File downloads are short-lived signed URLs; never permanent public URLs for private files (meter photos, ID documents, slips, inspection photos are all private).
- **Localisation**: `Accept-Language`. Server-generated documents (PDF, LINE Flex) are Thai by default; resident documents follow the resident's language where a translation exists (invoices and receipts are always Thai with the resident's language as a second block in R2).
- **Versioning**: breaking changes → new prefix (`/v2/...`) for the affected surface only; `/v1` kept until every consumer has migrated (same release train).

## 4. Auth handshake (backend is cookie-agnostic)
- Login endpoints return tokens in the **body**: `{ accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, subject: { id, type, roles, permissions, scopes } }`.
- Access token: JWT (EdDSA), 10–15 min, claims `sub`, `aud` (`operator|resident|technician|platform|device`), `sid`, `scp` (`tenant:<uuid>`; `building:<uuid>` when a Staff role is limited to buildings; `lease:<uuid>` and `unit:<uuid>` for residents; `work_order:<uuid>` for technicians). JWKS at `/v1/auth/.well-known/jwks.json`.
- Refresh token: opaque, rotating, single-use, stored hashed in `platform.auth_session`; reuse of a rotated token revokes the whole session family.
- Login methods: operators — phone OTP (primary) or email + password + optional TOTP (owners who want it); residents and technicians — LINE Login / LIFF id-token exchange (primary) or phone OTP magic link; platform — email + password + TOTP mandatory; devices — mTLS bootstrap (`POST /v1/device/bootstrap` with the provisioning code) → device JWT.
- `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `GET /v1/{owner|staff|resident|technician|admin}/me` (roles, permissions, menu entitlements, feature flags, scopes, current tenant/building context).
- The web app and the LIFF app store tokens in httpOnly cookies and forward them as `Authorization: Bearer` from their server (BFF). Browsers never hold tokens in JS-readable storage. The LIFF app obtains the LINE id token in the browser and exchanges it through its BFF, which sets the cookie.

## 5. Documentation requirements (Swagger + Scalar)
The generated OpenAPI document is the product, not a by-product: `getproperty-web`, `getproperty-liff`, `getproperty-edge`, lock/payment partners and QA all read it. Documentation completeness is enforced in CI, not by review.

**Served UIs** (from the same document, in every environment except production unless `DOCS_ENABLED=true`, and then behind platform auth or an IP allow-list):
- `/docs` — **Scalar API reference** (`@scalar/nestjs-api-reference`), the primary developer UI: search, per-surface grouping, request/response examples, client snippets, "try it" pointed at the sandbox server.
- `/docs/swagger` — Swagger UI.
- `/docs-json` and `/docs.yaml` — the raw document; `contract/openapi.json` in the repo is the same file, committed.

**Every operation must carry**: a stable `operationId` (`<surface>.<resource>.<action>`, e.g. `owner.invoices.issue`), a one-line `summary` and a `description` that states the business rule and links the decision id (`D-###`) it implements (and the legal reference for compliance rules), its surface tag, the security scheme for its audience, and `@ApiProperty` on every DTO field (type, format, nullable, enum as a named component, `example`, unit in the description, `deprecated` where relevant).

**Every operation must document all of its responses**, each with a schema **and at least one example**:
- success: `200` / `201` (+ `Location`) / `202` (async jobs, with the polling endpoint in the description) / `204`;
- errors as `application/problem+json` with the `code` values that operation can actually return — `400` malformed, `401` unauthenticated, `403` permission or audience/scope, `404` not found or not visible to this actor, `409` state conflict (e.g. `invoice.invalid_transition`, `compliance.acknowledgement_required`), `412` `concurrency.stale`, `422` validation and compliance refusals (with a field-level `errors[]` example), `429` rate limited (+ `Retry-After`), `500`, `503`;
- the shared error components are defined once and referenced, never re-declared per endpoint.

**Headers and parameters are documented too**: `Idempotency-Key`, `If-Match` / `ETag`, `Accept-Language`, `X-Request-Id`, `X-Tenant-Id` (tenant context for operators with several tenants; component `TenantIdHeader`), rate-limit headers, pagination, filter/sort and series query parameters with their allowed values.

**Also in the document**: `servers` (local, integration, sandbox, production), a description per tag, OpenAPI 3.1 `webhooks` for every inbound provider callback (payload + signature header + expected response), file-upload flows shown with examples, and money/date/meter-quantity formats restated in the info description.

**CI gates** (`pnpm contract:lint`): Spectral with the getproperty ruleset — fail when an operation lacks `operationId`, `summary`, tag, security, a documented `4xx`/`5xx` set, or an example on any request/response body; fail on inline enums, on `type: object` without properties, on duplicated schema shapes, and on any `example` containing real-looking personal data (Thai ID numbers, real phone numbers, real plate numbers). `pnpm contract:build` writes the document deterministically; drift and breaking-change checks run as in §1.

## 6. Realtime
- Server-sent events authorised by the API (`POST /v1/{surface}/realtime/auth`). Event payloads carry ids + type only (`invoice.paid`, `reading.received`, `device.offline`); the client refetches through the normal API. The owner console subscribes per building; the staff PWA per assigned building; the resident app per lease/unit; the technician app per work order.

## 7. Device surface (`/v1/device/*`, HTTPS) and MQTT
- HTTPS is used only for: `POST /v1/device/bootstrap` (provisioning code → certificate signing → device JWT), `POST /v1/device/token` (mTLS client certificate → short-lived device JWT), `POST /v1/device/certificate/renew`, `GET /v1/device/config` (full config on cold start; incremental changes arrive on MQTT `/config`), `GET /v1/device/ota/manifest`, `POST /v1/device/logs/presign` (log bundle upload), `POST /v1/device/readings/batch` (fallback when MQTT is blocked by the building's network; same envelope as MQTT, same dedup).
- MQTT topics, payload schemas, QoS, retained flags, dedup keys and buffer rules are in `docs/contract/device-protocol.md`; the JSON Schemas are generated into `contract/device-protocol.json` from the same DTO classes used by the MQTT ingest worker.

## 8. Tenancy scoping
- **Tenant context.** Every `/v1/owner/*` and `/v1/staff/*` request runs in exactly one tenant context: the `tenant:<uuid>` scope in the token when the operator has one tenant, or `X-Tenant-Id` (must be in the token's scopes) when they have several. Repositories receive `TenantContext`, add `tenant_id` to every query and open each transaction with `SET LOCAL app.tenant_id = '<uuid>'`; PostgreSQL row-level security on every tenant table (policy on `app.tenant_id`, schema-design v2 §4.5) is the second line. A cross-tenant id in a URL, filter, file key, cursor or export is a `404`, and the test suite includes these cases for every module.
- **Owner vs operator tenant.** A building has an `owner_tenant_id` (who owns it — the apartment owner, the condo juristic person) and an `operator_tenant_id` (who runs it now — the same tenant for an apartment, a PM company for a managed condo, the developer during the post-sale period). The operator sees and writes the building's rows on behalf of the owner; an operator change switches visibility without copying data.
- **Cross-tenant access only through `asset_access_grant`.** A tenant sees rows of another tenant's building or unit only when an active `core.asset_access_grant` names it as grantee, for that building or unit, for that module (`ops.lease`, `ops.billing`, `ops.service`, `smart.metering`, `warranty`, …), read or write, within its validity. Examples: a landlord sees its own units in a condo run by a juristic tenant; a PM company sees the buildings it manages; a developer keeps a warranty grant after the juristic person takes over. Grants are created by the building's owner/operator (or by integration events such as `building.handover.requested` and `juristic.formed`) and are audited.
- `/v1/resident/*` is scoped by the `lease:<uuid>` and `unit:<uuid>` lists in the token; the tenant context of each request is the tenant of the lease/unit named in the path (set as `app.tenant_id` the same way). A resident never sees another unit's data, and the building-level data they see (announcements, contacts, facilities) is filtered by building.
- `/v1/technician/*` is scoped by the `work_order:<uuid>` list in the token; a technician sees only those work orders, their unit/building address and the photos attached to them.
- `/v1/admin/*` sees every tenant through the platform database role; reads into a tenant's data by Support require an active, time-boxed **support grant** (D-090) and are written to the audit log; Platform admin bypasses the grant but is audited the same way.
- `/v1/device/*` and MQTT are scoped by the device's certificate → `device_id` → `tenant_id`/`building_id`; a gateway can only publish for meters bound to it in its config.
