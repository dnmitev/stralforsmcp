# Stralfors MCP extension for Claude Desktop

Forwards Claude Desktop's MCP traffic to a hosted Stralfors MCP server.

On install Desktop asks for two values:

- **Server URL**: `https://` address of the server (plain `http://` is accepted only for localhost).
- **Personal token**: your `smcp_` token. Desktop keeps it in the operating system secure store.

If you see an authorization error, the token is wrong or revoked: ask the server operator for a new one.
