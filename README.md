# Distributed Rate Limiter (Node.js + TypeScript)

> Built a distributed rate limiter in Node.js/TypeScript supporting multiple algorithms,
> Redis-backed fleet-wide enforcement, atomic concurrent decisions, graceful degradation,
> Prometheus metrics, Grafana dashboards, Dockerized infrastructure, and k6 load testing.

## 1. Problem statement

An API gateway in front of N backend instances must bound request rates to protect
**availability, security, fairness, and cost** — without becoming a single point of failure
itself. Per-instance in-memory counters are not enough: two gateway replicas would each
admit a full allowance (2× the intended rate). The limiter therefore needs:

- a reusable decision core (algorithm + shared state),
- one shared source of truth for fleet-wide counting,
- atomic state transitions under concurrency,
- explicit behavior when the shared store is slow or down,
- observable allow/deny/latency signals, proven under load.

## 2. Architecture

```text
 Client ──HTTP──► Node.js Gateway ──rate-limit decision──► RateLimiter Core
                        │                                            │
            Express + middleware + proxy                  Algorithm + Store
                        │                                     │           │
                     ALLOW / DENY                      MemoryStore   RedisStore
                        │                                                 │
                   429 ─┴──► proxy ──► Dummy Backend                    Redis
                                                                  (Lua atomicity)

 Node.js Gateway ── /metrics ──► Prometheus ──PromQL──► Grafana
```

Dependency direction is strict: `Gateway → RateLimiter → Algorithm + Store`.
Algorithms never import Express; the store never knows about HTTP; observability
holds no business logic.

```text
Algorithm = how the allowance behaves
Storage   = where the state lives / scope of enforcement
Atomicity = how correctness is maintained under concurrency
Gateway   = where requests are intercepted
```

## 3. Algorithms

| Algorithm | Model | Burst behavior | State | Use when |
|---|---|---|---|---|
| Token bucket | refill `r`/s up to capacity `C`; allow iff ≥1 token | bursty up to `C`, bounded average | `tokens, lastRefill` | general API traffic (default) |
| Fixed window | counter per `windowMs`; allow iff `count ≤ limit` | hard cliff; **boundary-burst** artifact (~2× across adjacent windows) | `count, windowStart` | simple coarse limits |
| Sliding window | weighted `prev×overlap + current`; allow iff `estimate < limit` | smooth, no boundary burst | `current, currentStart, previous` | accurate windows, tiny state |
| Leaky bucket | queue drains at fixed `leakRate`; allow iff `level+1 ≤ capacity` | shaped to constant output | `level, lastLeak` | protecting sensitive downstreams |

Selection mental model: need bursts → token bucket; need coarse simplicity → fixed window;
need smoothness with low memory → sliding window; need constant downstream output → leaky bucket.
The gateway picks per route (`/api/*` default token-bucket, `/api/expensive` strict fixed-window),
so strategy is a configuration decision, not hard-coded.

## 4. Distributed design

The unsafe pattern is read → check → write as three separate steps: concurrent gateways
observe the same stale count and all allow. The fix: **one atomic transition per decision**.

- Memory path: per-key promise-chain mutex (`MemoryStore.runExclusive`) + TTL sweep
  (no unbounded growth) + `incrementWithTtl` preserving anchored windows.
- Redis path: one Lua script per algorithm (`src/algorithms/lua.ts`) executed via
  `EVAL`, so refill/check/update + expiry happen atomically inside Redis.
  `Gateway 1/2/3 ─► one Redis ─► one decision`.

## 5. Failure behavior

The limiter is in the critical path, so degradation is explicit:

```text
Redis unavailable/slow → 150 ms timeout → MemoryStore fallback (per-instance bounds)
                        → fail-open (allow, availability) or fail-closed (deny, protection)
```

- `FAILURE_MODE=fail-closed` (default) vs `fail-open` via env.
- `ENABLE_FALLBACK=true` engages the memory tier; every engagement emits a structured
  warn log plus `rate_limiter_fallback_total{from,to}`.
- A slow Redis can never dominate latency: every store call races a timeout
  (`STORE_TIMEOUT_MS`, default 150 ms). Covered by `tests/unit/core/resilience.test.ts`
  (failing/hanging stores, fallback still enforces limits, hooks fire).

## 6. Gateway behavior

`HTTP → extract key → resolve rule → RateLimiter.check → 429 or proxy`.

- Key strategies (`resolveKey`, tested): `ip` (default, combined as `ip:<ip>:<route>`),
  `apiKey` (`x-api-key`), `userId` (`x-user-id`), `route`.
- Denied: `429` + `Retry-After` + `X-RateLimit-Limit/Remaining/Reset` + JSON body
  (`limit, remaining, retryAfterMs, resetMs`).
- Allowed: proxied (`/proxy/*` → `BACKEND_URL`) or dummy JSON (`/api/data`).
- `/health` and `/metrics` are never rate-limited.

## 7. Observability

| Metric | Type | Labels |
|---|---|---|
| `rate_limiter_decisions_total` | Counter | `algorithm, route, decision` |
| `rate_limiter_latency_seconds` | Histogram | `algorithm` |
| `rate_limiter_store_operations_total` | Counter | `store, operation, status` |
| `rate_limiter_store_errors_total` | Counter | `store, operation` |
| `rate_limiter_fallback_total` | Counter | `from, to` |

Dashboards (`grafana/dashboards`): **Traffic Overview** (total/allowed/denied/429,
by route/algorithm), **Health** (p95/p99 latency, store errors, fallbacks),
**Load Test** (allowed-vs-denied under k6, top blocked routes). Route labels use
bounded templates only — never raw user IDs.

## 8. How to run

```bash
cp .env.example .env
npm install
npm test            # 48 tests (unit + integration + soak; redis tests skip without Redis)
npm run dev         # memory mode on :3000
USE_REDIS=true npm run dev   # Redis primary + memory fallback (needs redis on :6379)

# Full stack: gateway :3000, backend :3001, prometheus :9090, grafana :3002, redis :6379
docker compose up --build
```

Ports: gateway `3000`, dummy backend `3001`, Redis `6379`, Prometheus `9090`,
Grafana `3002` (admin/admin).

## 9. Example calls

```bash
curl localhost:3000/health
# {"status":"ok"}

curl -i localhost:3000/api/data
# X-RateLimit-Limit: 20  X-RateLimit-Remaining: 19 ...

for i in $(seq 1 25); do curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/data; done
# twenty 200s, then 429s with {"error":"Too Many Requests",...,"retryAfterMs":...}

curl localhost:3000/metrics | grep rate_limiter_decisions_total
```

## 10. Benchmarks

Deterministic suite (`npm test`, 14 files / 48 tests, ~1 s, no Redis required):

- per-algorithm unit tests (allow/deny, refill, burst, window rollover, reset metadata),
- concurrency: 50 simultaneous checks → exactly the allowance admitted, for **all four**
  algorithms (memory mutex) and, with Redis up, all four Lua scripts,
- gateway: 50 concurrent `GET /api/data` → exactly 20 × 200 + 30 × 429 with headers,
- soak: sequential traffic partially refills mid-run; 429s always carry retry metadata.

Live traffic shapes: `npm run load` (k6: steady 10 VUs → burst 100 VUs → soak 20 VUs;
thresholds `p95 < 500 ms`, errors `< 1%`). Observe the 429 cliff on the Load Test
dashboard while it runs. Redis integration tests (`tests/integration/redis`) run the
same concurrency assertions against real Redis when `REDIS_URL` is reachable and skip
cleanly otherwise.

## 11. Design decisions

1. Algorithm and storage are independently replaceable; Lua lives with the algorithm,
   execution with the store.
2. Core never touches Express; stores never touch HTTP.
3. Atomicity first (mutex locally, Lua distributed), then performance.
4. Short store timeouts + explicit fail-open/closed + memory fallback (bounded per
   instance beats silently unprotected).
5. TTLs on every key; background sweep; `maxKeys` guard.
6. Metrics use bounded labels only; `/metrics` is unprotected by design.
7. Tests prove concurrency, not just logic — races are the actual risk.

## 12. Layout

`src/core` (limiter, types, errors) · `src/algorithms` (4 + `lua.ts`) ·
`src/stores` (memory, redis, instrumented wrapper) · `src/gateway`
(server, routes, middleware, proxy) · `src/config` · `src/observability` ·
`tests/unit|integration|load` · `prometheus/` · `grafana/` · `docker-compose.yml`.
