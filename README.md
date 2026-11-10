# stralforsmcp

> A hosted [Model Context Protocol](https://modelcontextprotocol.io) server for the Strålfors Output Management API — explore channels, inspect rules, validate invoices before sending and query delivery status from Claude Desktop, Cursor or Claude Code.

**Status:** Phase 1 (Stralfors client) in progress. A typed client library, mutation testing and CI exist; the MCP server itself follows in Phase 2. Nothing to install yet.

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

## Stralfors client (library)

`src/stralfors/` holds the API client (OAuth client credentials over mTLS, token caching). Configuration is read from the environment by `loadConfig`; secrets are given as file paths, never values.

| Variable | Required | Default |
|----------|----------|---------|
| `STRALFORS_ENV` | yes | `test` or `prod` |
| `STRALFORS_PROFILES` | yes | comma-separated profile ids, e.g. `test-a` |
| `STRALFORS_ALLOW_WRITE` | no | `false` (never `true` in prod) |
| `STRALFORS_PROD_VALIDATE_ENABLED` | no | `false` |
| `STRALFORS_TIMEOUT_MS` | no | `30000` |
| `STRALFORS_TOKEN_REFRESH_MARGIN_S` | no | `300` |
| `STRALFORS_MAX_BODY_BYTES` | no | `8388608` |

Per profile, with `<ID>` the upper-cased profile id (`-` becomes `_`, so `test-a` gives `TEST_A`):

| Variable | Required | Meaning |
|----------|----------|---------|
| `STRALFORS_PROFILE_<ID>_COUNTRY` | yes | country code |
| `STRALFORS_PROFILE_<ID>_CLIENT_ID_FILE` | yes | file holding the OAuth client id |
| `STRALFORS_PROFILE_<ID>_CLIENT_SECRET_FILE` | yes | file holding the OAuth client secret |
| `STRALFORS_PROFILE_<ID>_CERT_FILE` | yes | client certificate (PEM) |
| `STRALFORS_PROFILE_<ID>_KEY_FILE` | yes | private key (PEM) |
| `STRALFORS_PROFILE_<ID>_KEY_PASSPHRASE_FILE` | no | file holding the key passphrase |
| `STRALFORS_PROFILE_<ID>_ACTION_IDS` | no | comma-separated agreement ids, optionally labelled: `label:uuid,uuid` |

Smoke check against the live test API (manual, never run in CI): export the variables above, then `npm run live:channels`. It prints the token scopes, the client channel catalogue and the channels of each configured agreement by label (or `#1`, `#2`), never by id.

## Mutation testing

`npm run mutation` runs [StrykerJS](https://stryker-mutator.io) with the Vitest runner over the core modules (`src/stralfors/token.ts`, `errors.ts`, `http.ts`, `index.ts`, `config.ts`, `src/auth/token-store.ts`, `src/policy/policy.ts`, `src/audit/audit.ts`). Target score is 80 %; the run fails below 70 % (`break`). Reports land in `reports/mutation/` (`mutation.html`, `mutation.json`). The incremental file `reports/stryker-incremental.json` is kept between runs, so a re-run only tests what changed. CI runs this as the `mutation` job on Node 24, publishes the score in the job summary and uploads the report as an artifact.

Optional dashboard: enable the repository on the [Stryker dashboard](https://dashboard.stryker-mutator.io), then run `gh secret set STRYKER_DASHBOARD_API_KEY`. Until the secret exists, CI sends nothing.

## Contributing

Run once after cloning:

```sh
scripts/setup-hooks.sh
```

This activates the commit hooks in `.githooks/`: every commit is scanned with [gitleaks](https://github.com/gitleaks/gitleaks) (must be installed) and, optionally, against a personal denylist of terms that must never be committed. Set `STRALFORSMCP_DENYLIST` to the denylist path (one case-insensitive regex per line); matches are reported as a count only. Run `sh scripts/test-leak-guard.sh` to verify the guard.

Pull requests to `main` need green CI (Node 24 and 26, leak scan) and a `review/confidence` status of at least 90 % from the principal-reviewer agent (`.claude/agents/`) on the head commit; a new push requires a new review.

## Licence

[Apache-2.0](LICENSE)

## Disclaimer

Independent, unofficial project. Not affiliated with or endorsed by PostNord Strålfors. Refer to the official developer portal for authoritative API documentation.
