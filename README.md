# stralforsmcp

> A hosted [Model Context Protocol](https://modelcontextprotocol.io) server for the Strålfors Output Management API — explore channels, inspect rules, validate invoices before sending and query delivery status from Claude Desktop, Cursor or Claude Code.

**Status:** planning complete — Phase 0 (foundation) next. Nothing to install yet.

## Why

Integrating with the Strålfors Output Management API means working out channels, per-channel rules and payload shapes across several API products. This server puts the live API and a curated knowledge base behind an MCP interface, so developers, QA and product people can ask questions and validate payloads in plain language before anything is sent.

## Planned capabilities

| Tool | What it does |
|------|--------------|
| `whoami` | Shows your role, allowed environments and the API scopes available to you |
| `list_channels` | Lists delivery channels enabled for an agreement |
| `get_rules` | Shows the validation rules for a channel, in readable form |
| `get_example_invoice` | Returns a reference payload for one or more channels |
| `validate_invoice` | Validates a payload locally and with the API's own dry-run validation — nothing is sent |
| `channel_lookup` | Checks which channels a recipient can receive |
| `track_document` | Shows delivery status for a document |
| `send_invoice` | Sends to the **test** environment only |
| `search_docs` | Searches the knowledge base |

Plus ready-made prompts such as "Check my invoice" and "Which channels exist for a country?".

## Design principles

- **Hosted, credentials server-side only.** Client certificates and OAuth client credentials never leave the server. Users authenticate with personal, revocable tokens.
- **Production is read + validate only.** Write tools are not registered in production, outbound requests go through a deny-by-default allowlist, and the server refuses to start with an unsafe configuration.
- **Stateless Streamable HTTP**, safe to run with multiple replicas.
- **No payloads in logs or traces.** Allowlist-based structured logging with redaction and leak tests.

## Stack

TypeScript 7 · Node.js 24 and 26 · `@modelcontextprotocol/sdk` (Streamable HTTP) · undici (mTLS) · zod · pino · OpenTelemetry · Vitest · StrykerJS · Testcontainers + WireMock · oxlint · Docker · Helm

## Quality gates

| Gate | Threshold |
|------|-----------|
| Line coverage | ≥ 90 % |
| Mutation score (core modules) | ≥ 80 % target, CI fails below 70 % |
| Tests | 100 % passing on Node 24 and 26 |
| Lint + typecheck | 0 errors |
| Secret scanning | 0 findings |
| Container scan | 0 fixable high/critical |

CI publishes coverage, test pass rate and mutation score on every pull request.

## Roadmap

| Phase | Scope |
|-------|-------|
| 0 | Foundation: toolchain, leak guards, CI with reporting |
| 1 | API client: OAuth client credentials + mTLS, token caching, typed responses, structured logging |
| 2 | MCP core: Streamable HTTP, per-user auth, policy, audit log, tracing and metrics, container image, first Kubernetes deployment |
| 3 | Validation: rules, example payloads, dry-run validation, channel lookup, tracking |
| 4 | Knowledge: searchable knowledge base, resources and prompts |
| 5 | Additional countries and channels; test-environment sending |
| 6 | Production: full Helm chart, dashboards and alerts, Claude Desktop extension |

## Disclaimer

Independent, unofficial project. Not affiliated with or endorsed by PostNord Strålfors. Refer to the official developer portal for authoritative API documentation.
