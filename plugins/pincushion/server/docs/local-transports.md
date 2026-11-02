# Local HTTP transport security

Pincushion has three local HTTP consumers with separate authority. Loopback
binding is only a network boundary: other local browser processes can reach a
loopback port, so every local endpoint also checks its intended authority.

## REST wrapper

`npx pincushion-mcp --rest --port 3456` binds only to
`127.0.0.1:3456`. Every request must use that exact Host header and include
the current process's `X-Pincushion-Local-Capability` header. The server prints
the capability file path at startup. It lives below
`~/.pincushion/local-transports/`; the directory is mode `0700` and the
process-specific JSON file is mode `0600`.

The REST request bodies remain the documented JSON objects, such as
`{ "toolName": "get_feedback_summary", "args": {} }`. The default body limit is
256 KiB and the default body-read deadline is 10 seconds. Hosts may set
`PINCUSHION_LOCAL_HTTP_BODY_LIMIT_BYTES` (1 KiB through 4 MiB) and
`PINCUSHION_LOCAL_HTTP_REQUEST_TIMEOUT_MS` (25 ms through 60 seconds) to make
those limits stricter or looser within safe bounds.

Both local HTTP servers also impose a 15-second header deadline and a derived
whole-request receive deadline (at least 90 seconds, covering the header plus
the configured body window). Set
`PINCUSHION_LOCAL_HTTP_HEADER_TIMEOUT_MS` from 1 through 30 seconds when a
stricter header limit is needed. Node checks expired receive sockets at least
once per second. This receive budget ends once the request body is read. REST
`call-tool` execution gets a separate five-minute response
deadline, configurable with `PINCUSHION_LOCAL_HTTP_TOOL_TIMEOUT_MS` from 30
seconds through 15 minutes. If that execution deadline expires, the server
returns `202` with `tool_execution_pending`, `outcome: "unknown"`, and
`retrySafe: false`: work may already have completed or still be running, so a
blind retry is unsafe.

REST is for native local clients. It rejects any `Origin` header and sends no
generic CORS headers. Do not put the capability in a URL, browser page,
repository, log, or shared configuration. It rotates when the MCP process
restarts and is removed during graceful shutdown.

## Generated dashboard

`dashboard.html` is written mode `0600` and receives a different, per-process
dashboard capability. It may call only the dashboard read, approval, and
selection routes. The bridge accepts that capability only with no Origin or
`Origin: null`, which supports the local `file://` dashboard without treating
`file://` itself as authority.

For that dashboard only, the bridge answers a route-bound preflight from
`Origin: null` and permits the dashboard's content-type and capability
headers. REST and Chrome bridge routes do not inherit that CORS allowance.

The generated dashboard uses text nodes for annotation content and serializes
embedded data safely for its inline script. Do not copy, host, or publish the
generated HTML: its capability is process-bound and rotates on restart.

## Chrome bridge

`GET /bridge-challenge` accepts an exact Chrome-extension origin claim on the
exact loopback Host and returns only a stable process nonce, the
`pincushion-local-bridge` audience, and a fresh short `expiresAt`. The nonce
stays stable while the MCP process runs so a long-running process can request
new challenges after an earlier challenge expires.

Chrome bridge status reads and annotation pushes require a cloud-attested grant
in `X-Pincushion-Bridge-Grant`. The local server binds every grant check to one
project ID, one exact page URL, the process nonce, audience, and requested
scope. It validates the grant on every request through the cloud verifier.
The verifier owns any cloud account credential;
localhost requests never carry an account key.

Status responses contain only lifecycle fields needed to update an existing
pin: ID, authorized page/project binding, status, action, and lifecycle
timestamps. They never return cached annotation objects, comments,
screenshots, credentials, aliases, provider data, or workspace paths.

Chromium omits the native `Origin` header on extension background GETs. Chrome
therefore sends `X-Pincushion-Chrome-Origin`; this public claim must match the
native Origin whenever one is present and the cloud-issued grant's bound
origin. It never grants authority by itself. Chrome preflights permit only
content-type, this claim, and the opaque bridge-grant header on bridge routes.
Cloud verification has one three-second deadline across credential resolution,
response headers and body consumption; expiry or an unavailable verifier denies
the local operation without interrupting ordinary cloud sync.

Dashboard summary and approval operations use the same bounded execution
budget as REST. An approval timeout reports an unknown outcome and leaves the
local badge unchanged; confirm current state before retrying. REST bulk
annotation uploads accept at most 1,000 rows, and a failed REST port bind exits
with a nonzero status rather than leaving an unusable process running.
