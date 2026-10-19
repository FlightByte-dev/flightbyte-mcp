# Deploying the hosted endpoint on Dokploy

The hosted server at `https://mcp.flightbyte.dev/mcp` is this repo's `Dockerfile`: a stateless Streamable HTTP server on port 8080, with no database and no volumes. Callers send their own FlightByte key with each request, or sign in with OAuth; its one secret is the OAuth client secret it trades tokens with.

## 1. DNS

Point `mcp.flightbyte.dev` at the Dokploy server, the same way `api.flightbyte.dev` is set up: an `A` record to the server's IP (or a `CNAME` to its hostname). If the zone is behind Cloudflare, either use DNS-only (grey cloud) or keep the proxy on and raise `TRUST_PROXY` to `2` (see below).

## 2. Application

In Dokploy: **Create Service → Application**.

- **Provider:** GitHub, this repository, branch `main` (or Docker image, if you build and push it yourself).
- **Build Type:** Dockerfile, path `Dockerfile`, context `.`.
- **Environment:** nothing is required. Optional:

  | Variable | Default in the image | Meaning |
  | --- | --- | --- |
  | `RATE_LIMIT_PER_MINUTE` | `120` | POSTs to `/mcp` per client IP per minute; `0` turns it off. Per container. |
  | `TRUST_PROXY` | `1` | Reverse proxies in front whose `X-Forwarded-For` entries are trusted. `1` for Traefik alone, `2` with Cloudflare proxying in front of Traefik. |
  | `ALLOWED_HOSTS` | empty (any) | Comma-separated Host names accepted on `/mcp`, e.g. `mcp.flightbyte.dev`. |
  | `FLIGHTBYTE_API_URL` | `https://api.flightbyte.dev/v1` | Point at the API's internal address if you want to skip the public hop. |
  | `FLIGHTBYTE_DOCS_URL` | `https://flightbyte.dev` | Where `llms-full.txt` and `<page>.md` are fetched from. |
  | `FLIGHTBYTE_OAUTH_CLIENT_SECRET` | empty (OAuth off) | Turns OAuth on (Claude's connectors). The same value as the API's `OAUTH_MCP_CLIENT_SECRET`; at least 32 characters, e.g. `openssl rand -hex 32`. Mark it as a secret. |
  | `MCP_PUBLIC_URL` | `https://mcp.flightbyte.dev` | This server's public origin. `<MCP_PUBLIC_URL>/mcp` must equal the API's `OAUTH_MCP_RESOURCE`, character for character. |
  | `FLIGHTBYTE_OAUTH_ISSUER` | `https://api.flightbyte.dev` | The authorization server named in the protected resource metadata. |
  | `FLIGHTBYTE_OAUTH_TOKEN_URL` | `<issuer>/oauth/token` | Point at the API's internal address to trade tokens without the public hop. |

  Turn OAuth on only after the API (with `OAUTH_MCP_RESOURCE` and `OAUTH_MCP_CLIENT_SECRET`) and the dashboard (consent and Connected apps pages) are deployed: with it on, a signed-out call to an API tool sends people to sign in.

## 3. Domain

**Domains → Add Domain:** host `mcp.flightbyte.dev`, path `/`, container port `8080`, HTTPS on with Let's Encrypt.

## 4. Health check

The image has a Docker `HEALTHCHECK` on `GET /healthz`, which answers `{"status":"ok","version":"…"}`. If you also configure a check in Dokploy (Advanced → Health Check, or Swarm settings), use the same path and port.

## 5. Check it

```bash
curl https://mcp.flightbyte.dev/healthz
```

```bash
curl -s https://mcp.flightbyte.dev/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "authorization: Bearer $FLIGHTBYTE_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"retry after 429"}}}'
```

With OAuth on, also check the metadata and the challenge:

```bash
curl https://mcp.flightbyte.dev/.well-known/oauth-protected-resource/mcp
```

```bash
curl -si https://mcp.flightbyte.dev/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_flight","arguments":{"carrier":"TK","flightNumber":"1848","date":"2026-10-19"}}}' | grep -i "^HTTP\|www-authenticate"
```

The second answers `401` with `www-authenticate: Bearer resource_metadata="https://mcp.flightbyte.dev/.well-known/oauth-protected-resource/mcp", scope="…"`. Then add the URL in Claude under Customize → Connectors → Add custom connector and ask it about a flight.

## Notes

- Responses are plain JSON (no SSE streams, no sessions), so Traefik needs no special timeouts or sticky sessions, and you can run more than one replica. The rate limit is per replica.
- The container logs one line per request (method, path, status, duration, JSON-RPC method, and `key=yes`, `key=no` or `key=oauth`, with `auth=…` when a sign-in was asked for or refused). Keys, tokens, headers and bodies are never logged.
- With OAuth on, each signed-in conversation costs one token trade at the API per hour per replica; the trade is kept in memory and is lost on a restart, which costs one more trade, not a sign-in.
- The API's `/oauth/*` and `/.well-known/*` paths, and this server, must be reachable from Anthropic's outbound range `160.79.104.0/21`: if Cloudflare's bot protection or a WAF challenges them, Claude cannot connect.
- Redeploys are safe at any moment: there is no state to lose. SIGTERM closes the listener and the process exits.
