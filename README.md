<p align="center">
  <a href="https://flightbyte.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
      <img src="assets/logo-light.svg" alt="FlightByte" width="340">
    </picture>
  </a>
</p>

<h3 align="center">The FlightByte MCP server</h3>

<p align="center">
  Live flight status and flight webhooks as tools for your AI assistant.<br>
  Look flights up, watch them with signed webhooks, debug deliveries and search the docs<br>
  from Claude, Cursor, VS Code or any MCP client.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@flightbyte/mcp"><img src="https://img.shields.io/npm/v/@flightbyte/mcp?style=flat-square&color=EF6A1A&label=npm" alt="npm version"></a>
  <a href="https://mcp.flightbyte.dev/healthz"><img src="https://img.shields.io/website?url=https%3A%2F%2Fmcp.flightbyte.dev%2Fhealthz&style=flat-square&label=hosted&up_message=online&up_color=EF6A1A" alt="Hosted server status"></a>
  <img src="https://img.shields.io/badge/MCP-2025--11--25_%7C_2026--07--28-121212?style=flat-square" alt="MCP protocol versions">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-121212?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://flightbyte.dev/docs/ai"><b>Docs</b></a> ·
  <a href="https://app.flightbyte.dev/signup"><b>Get a free key</b></a> ·
  <a href="https://flightbyte.dev/docs/reference"><b>API reference</b></a> ·
  <a href="https://t.me/flightbyte"><b>Support</b></a>
</p>

<p align="center">
  <a href="https://cursor.com/en/install-mcp?name=flightbyte&config=eyJ1cmwiOiJodHRwczovL21jcC5mbGlnaHRieXRlLmRldi9tY3AiLCJoZWFkZXJzIjp7IkF1dGhvcml6YXRpb24iOiJCZWFyZXIgWU9VUl9GTElHSFRCWVRFX0tFWSJ9fQ%3D%3D"><img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Add to Cursor" height="32"></a>
  &nbsp;
  <a href="https://vscode.dev/redirect/mcp/install?name=flightbyte&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22flightbyte_key%22%2C%22description%22%3A%22FlightByte%20API%20key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.flightbyte.dev%2Fmcp%22%2C%22headers%22%3A%7B%22Authorization%22%3A%22Bearer%20%24%7Binput%3Aflightbyte_key%7D%22%7D%7D"><img src="https://img.shields.io/badge/VS_Code-Install_server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Install in VS Code" height="32"></a>
</p>

---

## Quick start

1. Get a free API key at [app.flightbyte.dev/signup](https://app.flightbyte.dev/signup).
2. Connect the server. Use the hosted one, or run it locally:

   | | Address | Key |
   | --- | --- | --- |
   | **Hosted** | `https://mcp.flightbyte.dev/mcp` | `Authorization: Bearer <key>` header |
   | **Local** | `npx -y @flightbyte/mcp` | `FLIGHTBYTE_KEY` environment variable |

   In Claude Code, for example:

   ```bash
   claude mcp add --transport http flightbyte https://mcp.flightbyte.dev/mcp \
     --header "Authorization: Bearer $FLIGHTBYTE_KEY"
   ```

   Every other client is under [Install](#install).
3. Ask: *"Is TK1848 on time today?"*

In Claude (claude.ai, Desktop or mobile) there is nothing to copy: add `https://mcp.flightbyte.dev/mcp` under **Customize → Connectors → Add custom connector**, and the first time Claude needs your account it asks you to sign in to FlightByte and allow it. See [Sign in with OAuth](#sign-in-with-oauth).

The docs tools work without a key or a sign-in, so an assistant can read the documentation before you have signed up.

## What you can ask

| You ask | What happens |
| --- | --- |
| *"Is TK1848 on time today? Which gate?"* | `get_flight` returns the live snapshot: phase, gate, terminal, delay, and the best known departure and arrival times. |
| *"TK1 from Istanbul tomorrow: when does it leave?"* | TK1 flies two legs that day. The assistant passes `origin: "IST"` and gets the right one instead of a guess. |
| *"Watch PC1001 on Friday and post every change to https://api.example.com/hooks/flights."* | `create_subscription` starts the watch and hands you the signing secret, shown once. |
| *"Our webhook stopped firing. Why?"* | `get_subscription` and `list_deliveries` show the status and the HTTP code and error of every recent attempt. |
| *"Add a FlightByte webhook receiver with signature verification to this Express app."* | `search_docs` and `get_doc_page` pull the exact steps from the docs, so the code matches the API rather than a guess. |

## Tools

**Docs**: no key needed.

| Tool | What it does |
| --- | --- |
| `search_docs` | Keyword search over the whole documentation: docs, API reference, guides and glossary. Returns titles, links and snippets. |
| `get_doc_page` | Any docs page as Markdown, from a link or a path like `/docs/webhooks`. |

**Flights**: read-only.

| Tool | What it does |
| --- | --- |
| `get_flight` | Live status of one flight leg: phase, gates, terminals, baggage belt, scheduled, estimated and actual times, delay, aircraft, codeshares, and every leg the number flies that day.<br><sub>`GET /v1/flights/{carrier}/{flightNumber}/{date}`</sub> |
| `search_flights` | The same lookup with query parameters.<br><sub>`GET /v1/flights/search`</sub> |
| `get_flight_timeline` | The airline's own change history for a leg, newest first.<br><sub>`GET /v1/flights/{carrier}/{flightNumber}/{date}/timeline`</sub> |

**Subscriptions**

| Tool | What it does | Access |
| --- | --- | --- |
| `create_subscription` | Watch a flight and get a signed webhook for every change. Counts as a watched flight on your plan.<br><sub>`POST /v1/subscriptions`</sub> | writes |
| `list_subscriptions` | Your subscriptions, filtered by status, carrier, number or date.<br><sub>`GET /v1/subscriptions`</sub> | read-only |
| `get_subscription` | One subscription with its status and delivery counters.<br><sub>`GET /v1/subscriptions/{id}`</sub> | read-only |
| `update_subscription` | Change the webhook URL, event filter, delay threshold, headers or metadata.<br><sub>`PATCH /v1/subscriptions/{id}`</sub> | writes |
| `pause_subscription` | Stop polling and deliveries without losing anything.<br><sub>`POST /v1/subscriptions/{id}/pause`</sub> | writes |
| `resume_subscription` | Resume a paused or auto-suspended subscription.<br><sub>`POST /v1/subscriptions/{id}/resume`</sub> | writes |
| `delete_subscription` | Delete a subscription for good.<br><sub>`DELETE /v1/subscriptions/{id}`</sub> | **destructive** |
| `send_test_event` | Send a signed test webhook to the subscription's URL.<br><sub>`POST /v1/subscriptions/{id}/test`</sub> | writes |
| `list_deliveries` | Recent delivery attempts with HTTP status and errors.<br><sub>`GET /v1/subscriptions/{id}/deliveries`</sub> | read-only |
| `list_events` | Recent events with the exact payloads that were sent.<br><sub>`GET /v1/subscriptions/{id}/events`</sub> | read-only |

Parameters carry the API's own names (`carrier`, `flightNumber`, `date`, `origin`, `webhookUrl`, `Idempotency-Key`, …), and the test suite checks every one against the [OpenAPI document](https://flightbyte.dev/openapi.json). Results are the API's JSON, as text and as structured content.

## Built for assistants

- **Your key stays yours.** The local server reads `FLIGHTBYTE_KEY`. The hosted server reads the key from each request's header, uses it for that request only, and never stores or logs it. Signed in with OAuth, the app never sees a key at all, and you can revoke it under [Connected apps](https://app.flightbyte.dev/connected-apps).
- **Secrets stay out of the chat.** There are no tools to reveal or rotate a webhook signing secret, because either would put it into the model's context and from there into transcripts. `create_subscription` returns the secret once, as the API does, and tells the assistant to hand it to you. Reveal or rotate secrets in the [dashboard](https://app.flightbyte.dev).
- **Clients know what is safe.** Read-only tools are marked read-only and `delete_subscription` is marked destructive, so clients can ask before running it. `create_subscription` tells the model it creates a billable watched flight and should only run when you ask for one.
- **Errors say what to do next.** A flight number that flies twice comes back with its legs and "pass `origin`". A `429` comes back with how long to wait. A `402 watched_flight_limit` says to stop, when the allowance resets, and where to upgrade.
- **Docs fetches stay on flightbyte.dev.** `get_doc_page` refuses every other host.

## Install

Replace `YOUR_FLIGHTBYTE_KEY` with your key. Every client below can use the hosted server; the local one needs Node.js 20 or later.

<details open>
<summary><b>Claude Code</b></summary>

<br>

Hosted:

```bash
claude mcp add --transport http flightbyte https://mcp.flightbyte.dev/mcp \
  --header "Authorization: Bearer YOUR_FLIGHTBYTE_KEY"
```

Local:

```bash
claude mcp add flightbyte --env FLIGHTBYTE_KEY=YOUR_FLIGHTBYTE_KEY \
  -- npx -y @flightbyte/mcp
```

Add `--scope user` to have it in every project. To share it with a team through a committed `.mcp.json`, keep the key in each person's environment:

```json
{
  "mcpServers": {
    "flightbyte": {
      "type": "http",
      "url": "https://mcp.flightbyte.dev/mcp",
      "headers": { "Authorization": "Bearer ${FLIGHTBYTE_KEY}" }
    }
  }
}
```

</details>

<details>
<summary><b>Cursor</b></summary>

<br>

Click **Add to Cursor** at the top for the hosted server, or [this link for the local one](https://cursor.com/en/install-mcp?name=flightbyte&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBmbGlnaHRieXRlL21jcCJdLCJlbnYiOnsiRkxJR0hUQllURV9LRVkiOiJZT1VSX0ZMSUdIVEJZVEVfS0VZIn19), then replace `YOUR_FLIGHTBYTE_KEY` in the installed entry. Or add it to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "flightbyte": {
      "url": "https://mcp.flightbyte.dev/mcp",
      "headers": { "Authorization": "Bearer YOUR_FLIGHTBYTE_KEY" }
    }
  }
}
```

Local:

```json
{
  "mcpServers": {
    "flightbyte": {
      "command": "npx",
      "args": ["-y", "@flightbyte/mcp"],
      "env": { "FLIGHTBYTE_KEY": "YOUR_FLIGHTBYTE_KEY" }
    }
  }
}
```

`"Bearer ${env:FLIGHTBYTE_KEY}"` also works, if Cursor was started from a shell that has the variable.

</details>

<details>
<summary><b>VS Code</b></summary>

<br>

Click **Install in VS Code** at the top: VS Code asks for the key and stores it securely. Or add it to `.vscode/mcp.json`:

```json
{
  "inputs": [
    { "type": "promptString", "id": "flightbyte_key", "description": "FlightByte API key", "password": true }
  ],
  "servers": {
    "flightbyte": {
      "type": "http",
      "url": "https://mcp.flightbyte.dev/mcp",
      "headers": { "Authorization": "Bearer ${input:flightbyte_key}" }
    }
  }
}
```

Local, from a terminal:

```bash
code --add-mcp '{"name":"flightbyte","type":"stdio","command":"npx","args":["-y","@flightbyte/mcp"],"env":{"FLIGHTBYTE_KEY":"YOUR_FLIGHTBYTE_KEY"}}'
```

</details>

<details>
<summary><b>Claude Desktop</b></summary>

<br>

Add the local server to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), then quit and reopen Claude:

```json
{
  "mcpServers": {
    "flightbyte": {
      "command": "npx",
      "args": ["-y", "@flightbyte/mcp"],
      "env": { "FLIGHTBYTE_KEY": "YOUR_FLIGHTBYTE_KEY" }
    }
  }
}
```

Or skip the key: add the hosted server under **Customize → Connectors → Add custom connector** with the URL `https://mcp.flightbyte.dev/mcp` (on Team and Enterprise plans an Owner adds it under **Organization settings → Connectors**). If the dialog asks, pick **Sign in when needed** and **Use Claude's published identity**. The docs tools work right away; the first time Claude calls a tool that needs your account, it shows a **Connect** button, you sign in to FlightByte and allow it, and the call goes through. See [Sign in with OAuth](#sign-in-with-oauth).

</details>

<details>
<summary><b>Any other client</b></summary>

<br>

- **Streamable HTTP:** `https://mcp.flightbyte.dev/mcp` with the header `Authorization: Bearer YOUR_FLIGHTBYTE_KEY` (or `x-api-key: YOUR_FLIGHTBYTE_KEY`).
- **stdio:** command `npx`, arguments `-y @flightbyte/mcp`, environment `FLIGHTBYTE_KEY=YOUR_FLIGHTBYTE_KEY`.

Both speak MCP 2026-07-28 and the 2025 revisions (2024-11-05 to 2025-11-25); the client's first message picks one. A Streamable HTTP client that supports MCP authorization can sign in with OAuth instead of sending a key.

</details>

## Sign in with OAuth

The hosted server is an OAuth 2.1 protected resource, as the [MCP authorization spec](https://modelcontextprotocol.io/specification/latest/basic/authorization) describes, so clients that take OAuth and no API key (Claude's connectors) can use it with your account.

- **Signed out**, `initialize`, `tools/list`, `search_docs` and `get_doc_page` work. Calling an API tool answers `401` with `WWW-Authenticate: Bearer resource_metadata="https://mcp.flightbyte.dev/.well-known/oauth-protected-resource/mcp"`, which is what makes the client offer to sign in.
- **The authorization server** is the FlightByte API (`https://api.flightbyte.dev`, metadata at `/.well-known/oauth-authorization-server`). You sign in to the dashboard and allow the app there; it acts as one of your API keys, so that key's plan, quota, logs and watched flights apply. Clients identify themselves with a Client ID Metadata Document (as Claude and Claude Code do) or register dynamically; PKCE is required, and refresh tokens rotate.
- **Scopes:** `flights:read` (the flight tools), `subscriptions:read` (listing watches, deliveries and events) and `subscriptions:write` (creating, changing and deleting watches, and test events). A tool outside the granted scopes answers `403 insufficient_scope`.
- **Tokens are never passed through.** The MCP spec forbids sending a client's token on to another API, so this server trades it at the authorization server ([RFC 8693](https://www.rfc-editor.org/rfc/rfc8693)) for a short-lived token for the API, with a client secret of its own, and keeps the trade in memory until it expires. Revoking the app under Connected apps, or revoking the key it acts as, stops it on its next request.
- **API keys work exactly as before**, in either header. OAuth is off unless `FLIGHTBYTE_OAUTH_CLIENT_SECRET` is set.

## Configuration

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `FLIGHTBYTE_KEY` | local | none | Your API key. Without it the API tools explain how to set one and the docs tools still work. The hosted server ignores it and reads the key from each request. |
| `FLIGHTBYTE_API_URL` | both | `https://api.flightbyte.dev/v1` | API base URL, e.g. `http://localhost:3000/v1` for a local API. |
| `FLIGHTBYTE_DOCS_URL` | both | `https://flightbyte.dev` | Docs site that serves `/llms-full.txt` and `<page>.md`. |
| `PORT` | HTTP | `8080` | Listening port. |
| `HOST` | HTTP | `127.0.0.1` (`0.0.0.0` in Docker) | Listening address. |
| `RATE_LIMIT_PER_MINUTE` | HTTP | `120` | Requests to `/mcp` per client IP per minute; `0` turns it off. |
| `TRUST_PROXY` | HTTP | `0` (`1` in Docker) | How many reverse proxies' `X-Forwarded-For` entries to trust when finding the client IP. |
| `ALLOWED_HOSTS` | HTTP | loopback names on a loopback `HOST`, otherwise any | Comma-separated `Host` values accepted on `/mcp`, against DNS rebinding. |
| `FLIGHTBYTE_OAUTH_CLIENT_SECRET` | HTTP | none | Turns OAuth on: this server's secret at the authorization server, used only to trade tokens. Must match the API's `OAUTH_MCP_CLIENT_SECRET`. |
| `MCP_PUBLIC_URL` | HTTP | `https://mcp.flightbyte.dev` | This server's public origin; the OAuth resource is `<MCP_PUBLIC_URL>/mcp` and must equal the API's `OAUTH_MCP_RESOURCE`. |
| `FLIGHTBYTE_OAUTH_ISSUER` | HTTP | `https://api.flightbyte.dev` | The authorization server named in the protected resource metadata. |
| `FLIGHTBYTE_OAUTH_TOKEN_URL` | HTTP | `<issuer>/oauth/token` | Where tokens are traded, e.g. the API's internal address. |
| `FLIGHTBYTE_OAUTH_CLIENT_ID` | HTTP | `flightbyte-mcp` | This server's client id at the authorization server. |

## Self-hosting

The hosted server is this repository's `Dockerfile`: a stateless Streamable HTTP server with no database. Its one secret is the OAuth client secret, and only when OAuth is on.

```bash
docker build -t flightbyte-mcp .
docker run -p 8080:8080 flightbyte-mcp
```

It serves `POST /mcp` and `GET /healthz`. Each request gets a fresh server bound to the key in its headers; responses are plain JSON with no sessions, so it scales to any number of replicas. Requests in the 2026-07-28 format are served by the SDK's per-request handler, and 2025-era requests by a JSON-mode Streamable HTTP transport. Deployment notes for Dokploy are in [DEPLOY.md](DEPLOY.md).

## Development

Running the server needs Node.js 20 or later; developing it needs 22.12 or later.

```bash
npm install
npm run build        # TypeScript → dist/
npm test             # builds, then runs everything against a local mock of the API and docs
npm run typecheck
npm run lint
```

The tests never touch the real API and need no key. They cover every tool's request mapping, the error mapping, docs parsing and ranking, and both transports end to end: the built `dist/stdio.js` and `dist/http.js` are spawned and driven by MCP clients on protocol 2025-11-25 and 2026-07-28, including one built on the v1 SDK. A drift check fails when a tool's parameter names, locations, required fields or enums stop matching `spec/openapi.json`, a copy of the [public OpenAPI document](https://flightbyte.dev/openapi.json). When the API changes:

```bash
npm run sync:openapi
npm test
```

Try it by hand with the MCP Inspector, or against a local API:

```bash
npx @modelcontextprotocol/inspector node dist/stdio.js
```

```bash
FLIGHTBYTE_API_URL=http://localhost:3000/v1 FLIGHTBYTE_KEY=your-local-key node dist/stdio.js
```

<details>
<summary><b>Project layout</b></summary>

```text
src/
  stdio.ts            bin entry: stdio transport, key from FLIGHTBYTE_KEY
  http.ts             HTTP entry: POST /mcp, GET /healthz, env config
  http-app.ts         request handling, protocol routing, key extraction, the OAuth gate, per-IP rate limit
  oauth.ts            protected resource metadata, WWW-Authenticate challenges, the token trade
  server.ts           createServer(): registers every tool on an McpServer
  tools/api-tools.ts  the 13 API tools, one definition per OpenAPI operation
  tools/docs-tools.ts search_docs and get_doc_page
  docs.ts             llms-full.txt parsing, ranking, caching, page fetches
  api.ts              fetch wrapper for the REST API
  errors.ts           error envelope → tool error with next steps
spec/openapi.json     copy of the public OpenAPI document (npm run sync:openapi)
server.json           MCP Registry entry: the npm package and the hosted remote
```

</details>

<details>
<summary><b>Releasing</b></summary>

1. Bump `version` in `package.json` and in both places in `server.json`; a test fails if they differ.
2. `npm publish`. It runs typecheck, lint and tests first, and publishes publicly under the `@flightbyte` scope.
3. Publish `server.json` to the [MCP Registry](https://registry.modelcontextprotocol.io): `mcp-publisher login dns --domain flightbyte.dev …`, then `mcp-publisher publish`.
4. Redeploy the Docker image behind `mcp.flightbyte.dev`.

</details>

## License

[MIT](LICENSE)

<br>

<p align="center">
  <a href="https://flightbyte.dev"><img src="assets/icon.svg" alt="FlightByte" width="36"></a>
  <br>
  <sub><b>FlightByte</b> · Flight intelligence, byte by byte · <a href="https://flightbyte.dev">flightbyte.dev</a></sub>
</p>
