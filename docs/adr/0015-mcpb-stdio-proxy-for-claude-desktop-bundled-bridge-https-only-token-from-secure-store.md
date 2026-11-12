---
status: accepted
---
# MCPB stdio proxy for Claude Desktop: bundled bridge, https only, token from the secure store

Phase 2 ships a Claude Desktop extension (`extension/`, built by `npm run mcpb:build` into `dist/stralforsmcp.mcpb`) that forwards Desktop's MCP traffic to the hosted server. Signing and distribution are Phase 6 (06-03).

## Decision

1. **A local stdio proxy, not a custom connector.** Desktop's custom connectors authenticate with OAuth or, in beta, one shared static header, and they are called from Anthropic's cloud. A server that is not publicly reachable cannot be used that way, and a per-user token cannot be expressed natively. A desktop extension runs on the user's machine, speaks stdio to Desktop and Streamable HTTP to the server, so it can reach a private hostname and send each user's own bearer token. Claude Code and Cursor can send the header themselves and need no extension.
2. **The token is a `sensitive` `user_config` value.** Desktop stores it in the operating system secure store and hands it to the bridge as the environment variable `MCP_TOKEN`, never in argv, so it does not appear in a process listing. The server URL is a non-sensitive value passed as `MCP_URL`.
3. **https only, except loopback.** The bridge refuses to start with an `http://` URL unless the host is `localhost`, `127.0.0.1` or `[::1]`, so the bearer token is never sent in clear text over a network.
4. **The bridge interprets nothing.** It forwards MCP messages verbatim in both directions and adds only the `Authorization: Bearer` header. Tool lists, results and errors are the server's; a 401 reaches the user as an authorization error from the server.
5. **One JavaScript file, no `node_modules`.** esbuild bundles the bridge and the SDK into `server/index.js` (about 1.4 MB unzipped, about 300 KB zipped), so the extension needs only the Node runtime Desktop provides. The `.mcpb` is a plain zip written by fflate.
6. **Unsigned in 02-08.** Signing, organisation upload and release come with Phase 6 (06-03). Until then Desktop may warn about an unsigned extension.
7. **New devDependencies `esbuild` 0.28.2 and `fflate` 0.8.3, exact-pinned.** Both are dev only, are not in the image (production dependencies only) and are used only by `scripts/build-mcpb.ts`. esbuild is installed with install scripts ignored; its platform binary comes from its optional dependency.
8. **The official `@anthropic-ai/mcpb` CLI is not a dependency.** It pulls in about 54 packages and `npm audit` reports 3 high findings (in zod and tmp) with no fix available. Instead the build is esbuild plus fflate, and `test/extension.test.ts` checks the manifest against our own schema. The maintainer runs `npx @anthropic-ai/mcpb validate extension/manifest.json` once at the Desktop checkpoint.

## Known limits and UNVERIFIED items

The Desktop checkpoint (manual install in Claude Desktop) answers these:

- Whether the `MCP-Protocol-Version` header handling is accepted by the server through the proxy.
- What the proxy sees when a session expires and the server answers 404.
- The wording and severity of Desktop's unsigned-extension warning.
- Desktop's bundled Node version against the manifest's `node >=18` target.

Known limits: transport stream errors are fatal only when a send fails, and there is no reconnect.

## Revisit when

The checkpoint contradicts any item above, Desktop custom connectors gain per-user headers for private servers, the `@anthropic-ai/mcpb` audit findings are fixed, or Phase 6 adds signing.
