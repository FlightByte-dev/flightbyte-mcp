# Deploying the hosted endpoint on Dokploy

The hosted server at `https://mcp.flightbyte.dev/mcp` is this repo's `Dockerfile`: a stateless Streamable HTTP server on port 8080, with no database and no volumes. It holds no secrets of its own: every caller sends their own FlightByte key with each request.

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

## Notes

- Responses are plain JSON (no SSE streams, no sessions), so Traefik needs no special timeouts or sticky sessions, and you can run more than one replica. The rate limit is per replica.
- The container logs one line per request (method, path, status, duration, JSON-RPC method, and whether a key was present). Keys, headers and bodies are never logged.
- Redeploys are safe at any moment: there is no state to lose. SIGTERM closes the listener and the process exits.
