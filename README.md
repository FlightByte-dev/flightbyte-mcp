# FlightByte MCP server

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=flightbyte&config=eyJ1cmwiOiJodHRwczovL21jcC5mbGlnaHRieXRlLmRldi9tY3AiLCJoZWFkZXJzIjp7IkF1dGhvcml6YXRpb24iOiJCZWFyZXIgWU9VUl9GTElHSFRCWVRFX0tFWSJ9fQ%3D%3D)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=flightbyte&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22flightbyte_key%22%2C%22description%22%3A%22FlightByte%20API%20key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.flightbyte.dev%2Fmcp%22%2C%22headers%22%3A%7B%22Authorization%22%3A%22Bearer%20%24%7Binput%3Aflightbyte_key%7D%22%7D%7D)

[FlightByte](https://flightbyte.dev) is a flight status API with signed webhooks. This [Model Context Protocol](https://modelcontextprotocol.io) server lets an AI assistant use it directly: look a flight up by carrier, number and date, watch it with a webhook subscription, manage and debug those subscriptions, and search the FlightByte documentation while it writes your integration.

It is a thin client over the public API at `https://api.flightbyte.dev/v1` and the docs at `https://flightbyte.dev/docs`, and it ships two ways from one codebase:

| | How | Key |
| --- | --- | --- |
| **Hosted** | `https://mcp.flightbyte.dev/mcp` (Streamable HTTP) | `Authorization: Bearer <key>` header (or `x-api-key`) |
| **Local** | `npx -y @flightbyte/mcp` (stdio) | `FLIGHTBYTE_KEY` environment variable |

Get a free key at [app.flightbyte.dev/signup](https://app.flightbyte.dev/signup). The docs tools work without one.

## Tools

| Tool | What it does | API | Hints |
| --- | --- | --- | --- |
| `search_docs` | Keyword search over the whole documentation (docs, API reference, guides, glossary); returns titles, URLs and snippets. No key needed. | `llms-full.txt` | read-only |
| `get_doc_page` | One docs page as Markdown, from a URL or a path like `/docs/webhooks`. No key needed. | `<page>.md` | read-only |
| `get_flight` | Live status of one flight leg: phase, gates, terminals, baggage belt, scheduled/estimated/actual times, delay, aircraft, codeshares, every leg of the number that day. | `GET /v1/flights/{carrier}/{flightNumber}/{date}` | read-only |
| `search_flights` | The same lookup as query parameters. | `GET /v1/flights/search` | read-only |
| `get_flight_timeline` | The airline's change history for a leg, newest first. | `GET /v1/flights/{carrier}/{flightNumber}/{date}/timeline` | read-only |
| `create_subscription` | Watch a flight and receive a signed webhook for every change. Counts as a watched flight on your plan. Returns the signing secret once. | `POST /v1/subscriptions` | writes |
| `list_subscriptions` | Your subscriptions, filtered by status, carrier, number or date. | `GET /v1/subscriptions` | read-only |
| `get_subscription` | One subscription, its status and delivery counters. | `GET /v1/subscriptions/{id}` | read-only |
| `update_subscription` | Change the webhook URL, event filter, delay threshold, headers or metadata. | `PATCH /v1/subscriptions/{id}` | writes, idempotent |
| `pause_subscription` | Stop polling and deliveries without losing the subscription. | `POST /v1/subscriptions/{id}/pause` | writes, idempotent |
| `resume_subscription` | Resume a paused or auto-suspended subscription. | `POST /v1/subscriptions/{id}/resume` | writes, idempotent |
| `delete_subscription` | Delete a subscription for good. | `DELETE /v1/subscriptions/{id}` | **destructive** |
| `send_test_event` | Send a signed test webhook to the subscription's URL. | `POST /v1/subscriptions/{id}/test` | writes |
| `list_deliveries` | Recent delivery attempts with HTTP status and errors. | `GET /v1/subscriptions/{id}/deliveries` | read-only |
| `list_events` | Recent events with the exact payloads that were sent. | `GET /v1/subscriptions/{id}/events` | read-only |

Input parameters carry the API's own names (`carrier`, `flightNumber`, `date`, `origin`, `webhookUrl`, `delayThresholdMinutes`, `Idempotency-Key`, …), checked against the [OpenAPI document](https://flightbyte.dev/openapi.json) by the test suite. Results are the API's JSON, as text and as `structuredContent`. Errors come back as tool errors that say what to do next: pass `origin` when a flight number flies more than one leg, wait for `Retry-After` on a `429`, stop on `402 watched_flight_limit`, and so on.

### Left out on purpose

- **`reveal-secret` and `rotate-secret` are not exposed.** Either would put a webhook signing secret into the model's context, and from there into transcripts and logs. `create_subscription` returns the secret once because the API does, and its result tells the assistant to hand it to you. To see or rotate a secret later, use the [dashboard](https://app.flightbyte.dev) or call the API yourself.
- Countries and flags (`/v1/countries`, `/v1/flags`) are not exposed in v1.

## Install

Replace `YOUR_FLIGHTBYTE_KEY` with your key in the snippets below.

### Claude Code

Hosted:

```bash
claude mcp add --transport http flightbyte https://mcp.flightbyte.dev/mcp --header "Authorization: Bearer YOUR_FLIGHTBYTE_KEY"
```

Local:

```bash
claude mcp add flightbyte --env FLIGHTBYTE_KEY=YOUR_FLIGHTBYTE_KEY -- npx -y @flightbyte/mcp
```

Add `--scope user` to make it available in every project. To share it with a team through a committed `.mcp.json`, keep the key in each person's environment:

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

### Cursor

Click **Install in Cursor** above (hosted) or [this link for the local server](https://cursor.com/en/install-mcp?name=flightbyte&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBmbGlnaHRieXRlL21jcCJdLCJlbnYiOnsiRkxJR0hUQllURV9LRVkiOiJZT1VSX0ZMSUdIVEJZVEVfS0VZIn19), then replace `YOUR_FLIGHTBYTE_KEY` in the installed entry. Or edit `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project) yourself:

```json
{
  "mcpServers": {
    "flightbyte": {
      "url": "https://mcp.flightbyte.dev/mcp",
      "headers": { "Authorization": "Bearer ${env:FLIGHTBYTE_KEY}" }
    }
  }
}
```

The local form:

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

`${env:FLIGHTBYTE_KEY}` only works if Cursor was started from a shell that has the variable; otherwise put the key in directly.

### VS Code

Click **Install in VS Code** above; VS Code asks for the key and stores it securely. Or add it to `.vscode/mcp.json`:

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

The local form uses `"type": "stdio", "command": "npx", "args": ["-y", "@flightbyte/mcp"], "env": { "FLIGHTBYTE_KEY": "${input:flightbyte_key}" }` in place of `type`, `url` and `headers`. From a terminal:

```bash
code --add-mcp '{"name":"flightbyte","type":"stdio","command":"npx","args":["-y","@flightbyte/mcp"],"env":{"FLIGHTBYTE_KEY":"YOUR_FLIGHTBYTE_KEY"}}'
```

### Claude Desktop

Add the local server to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then quit and reopen Claude:

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

The hosted server can also be added under **Settings → Connectors → Add custom connector** with the URL `https://mcp.flightbyte.dev/mcp`. Sending the key needs the connector's **Request headers** option (`authorization: Bearer YOUR_FLIGHTBYTE_KEY`), which is in beta and not available to every account; without it only the docs tools work, so the local form above is the reliable one.

### Any other client

- Streamable HTTP: `https://mcp.flightbyte.dev/mcp`, header `Authorization: Bearer YOUR_FLIGHTBYTE_KEY` (or `x-api-key: YOUR_FLIGHTBYTE_KEY`).
- stdio: command `npx`, arguments `-y @flightbyte/mcp`, environment `FLIGHTBYTE_KEY=YOUR_FLIGHTBYTE_KEY`.

Both transports speak MCP 2026-07-28 and the 2025 revisions (2024-11-05 to 2025-11-25): the client's first message picks one.

## Configuration

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `FLIGHTBYTE_KEY` | stdio | none | Your API key. Without it the API tools return a message explaining how to set it, and the docs tools still work. The HTTP server ignores it and reads the key from each request instead. |
| `FLIGHTBYTE_API_URL` | both | `https://api.flightbyte.dev/v1` | API base URL, e.g. `http://localhost:3000/v1` for a local API. |
| `FLIGHTBYTE_DOCS_URL` | both | `https://flightbyte.dev` | Docs site that serves `/llms-full.txt` and `<page>.md`. |
| `PORT` | HTTP | `8080` | Listening port. |
| `HOST` | HTTP | `127.0.0.1` (`0.0.0.0` in the Docker image) | Listening address. |
| `RATE_LIMIT_PER_MINUTE` | HTTP | `120` | POSTs to `/mcp` per client IP per minute; `0` disables it. |
| `TRUST_PROXY` | HTTP | `0` (`1` in the Docker image) | How many reverse proxies' `X-Forwarded-For` entries to trust when working out the client IP. |
| `ALLOWED_HOSTS` | HTTP | loopback names when `HOST` is loopback, otherwise any | Comma-separated `Host` header values accepted on `/mcp` (DNS rebinding protection). |

## The HTTP server

`npm run start:http` (or the Docker image) serves:

- `POST /mcp`: MCP over Streamable HTTP in stateless mode. Every request gets a fresh server bound to the key in that request's headers; responses are plain JSON, there are no sessions, and `GET`/`DELETE /mcp` answer `405`. Requests carrying the 2026-07-28 per-request envelope are served by the SDK's `createMcpHandler`; 2025-era requests (`initialize`, then plain JSON-RPC) by a JSON-mode Streamable HTTP transport. The request log notes which (`era=modern` or `era=legacy`).
- `GET /healthz`: `{"status":"ok","version":"…"}`.

Keys are used for the one request and never stored or logged. The docs index is cached in memory for 15 minutes and shared by all requests. Deployment notes for Dokploy are in [DEPLOY.md](DEPLOY.md).

## Local development

Running the server needs Node.js 20 or later; developing it needs Node.js 22.12 or later (for vitest).

```bash
npm install
npm run build        # TypeScript → dist/
npm test             # builds, then runs every test against a local mock API and docs site
npm run typecheck
npm run lint
```

The tests never touch the real API or need a key. They cover the request mapping of every tool, the error mapping, docs parsing and ranking, both transports end to end (the built `dist/stdio.js` and `dist/http.js` are spawned and driven by MCP clients on protocol 2025-11-25 and 2026-07-28, including a client built on the v1 SDK, `@modelcontextprotocol/sdk`, which is a dev dependency for that test only), and a drift check: every API tool's parameters must exist, in the same place and with the same required fields and enums, in `spec/openapi.json`, a vendored copy of [the public OpenAPI document](https://flightbyte.dev/openapi.json). When the API changes:

```bash
npm run sync:openapi
npm test
```

Try the server by hand with the MCP Inspector, or against a local API:

```bash
npx @modelcontextprotocol/inspector node dist/stdio.js
```

```bash
FLIGHTBYTE_API_URL=http://localhost:3000/v1 FLIGHTBYTE_KEY=your-local-key node dist/stdio.js
```

```bash
npm run start:http
```

```bash
curl -s http://127.0.0.1:8080/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "authorization: Bearer $FLIGHTBYTE_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_flight","arguments":{"carrier":"TK","flightNumber":"1848","date":"2026-10-18"}}}'
```

### Layout

```text
src/
  stdio.ts            bin entry: stdio transport (serveStdio), key from FLIGHTBYTE_KEY
  http.ts             HTTP entry: POST /mcp, GET /healthz, env config
  http-app.ts         request handling, era routing, key extraction, per-IP rate limit
  server.ts           createServer(): registers every tool on an McpServer
  tools/api-tools.ts  the 13 API tools, one definition per OpenAPI operation
  tools/docs-tools.ts search_docs and get_doc_page
  docs.ts             llms-full.txt parsing, ranking, caching, page fetches
  api.ts              fetch wrapper for the REST API
  errors.ts           error envelope → tool error with next steps
spec/openapi.json     vendored OpenAPI document (npm run sync:openapi)
server.json           MCP Registry entry (npm package and hosted remote)
```

### Releasing

1. Bump `version` in `package.json` and in both places in `server.json` (a test fails if they differ).
2. `npm publish` (runs typecheck, lint and tests first; the package is public under the `@flightbyte` scope).
3. Publish `server.json` to the [MCP Registry](https://registry.modelcontextprotocol.io) with `mcp-publisher login dns --domain flightbyte.dev …` and `mcp-publisher publish`.
4. Redeploy the Docker image for `mcp.flightbyte.dev`.

## License

[MIT](LICENSE)
