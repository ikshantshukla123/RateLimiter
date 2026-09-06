# Distributed Rate Limiter — Project Agent Guide

## 1. Project Overview

We are building a **production-style distributed rate limiter in Node.js + TypeScript**.

The project will not be just an Express middleware. The core goal is to build a reusable rate-limiting component and demonstrate it through an Express-based API gateway that protects a downstream backend service.

The project will also include Redis for shared distributed state, Prometheus for metrics collection, Grafana for visualization, Docker Compose for local infrastructure, and k6 for load/concurrency testing.

### Primary learning goals

- Backend engineering with Node.js/TypeScript
- Rate-limiting algorithms and their trade-offs
- Concurrency and atomicity
- Distributed shared state
- Redis and atomic operations / Lua scripting
- Resilience and failure handling
- Observability with Prometheus + Grafana
- Load testing and correctness testing
- Clean architecture and separation of concerns

The underlying rate-limiter design is language-independent. The implementation-specific differences are mainly around Node.js concurrency, HTTP middleware, TypeScript interfaces, and Redis integration.

---

## 2. High-Level Architecture

```text
                         ┌──────────────────┐
                         │      Client      │
                         └────────┬─────────┘
                                  │ HTTP
                                  ▼
                    ┌───────────────────────────┐
                    │      Node.js Gateway      │
                    │                           │
                    │  Express HTTP Layer       │
                    │  Rate-Limit Middleware    │
                    │  Routing / Proxying       │
                    └─────────────┬─────────────┘
                                  │
                           rate-limit decision
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │       RateLimiter         │
                    │       Core Component      │
                    └─────────────┬─────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
                    ▼                           ▼
             ┌──────────────┐           ┌──────────────┐
             │  Algorithm   │           │    Store     │
             │              │           │              │
             │ Token Bucket │           │ MemoryStore  │
             │ Fixed Window │           │ RedisStore   │
             │ Sliding Win. │           │              │
             │ Leaky Bucket│           └──────┬───────┘
             └──────────────┘                  │
                                               ▼
                                           ┌───────┐
                                           │ Redis │
                                           └───────┘

                                  │
                           ┌──────┴──────┐
                           │             │
                         DENY          ALLOW
                           │             │
                           ▼             ▼
                      HTTP 429      Downstream API
                                         │
                                         ▼
                                  Dummy Backend

       Node.js Gateway ───── metrics ─────► Prometheus
                                               │
                                               ▼
                                            Grafana
```

### Core mental model

```text
Algorithm = how the allowance behaves
Storage   = where the state lives / scope of enforcement
Atomicity = how correctness is maintained under concurrency
Gateway   = where requests are intercepted
Prometheus = metrics collection/storage
Grafana   = metrics visualization
```

---

## 3. What We Are Actually Building

The project has two distinct layers:

### A. Reusable rate-limiter core

This is the main engineering project.

It should be independent of Express and should expose a clean interface for checking whether a request/key is allowed.

Conceptually:

```text
check(key, rule)
      ↓
 algorithm decision
      ↓
 store state
      ↓
 Allow / Deny + metadata
```

The core should eventually support multiple algorithms and multiple storage backends.

### B. Express API gateway / demo application

Express is used as the HTTP gateway/demo environment around the core limiter.

The gateway will:

1. Receive the client request.
2. Determine the limiting identity/key.
3. Invoke the rate limiter.
4. Return `429 Too Many Requests` when denied.
5. Forward/proxy allowed requests to the downstream backend.
6. Expose metrics.

The Express gateway is **not the same thing as the rate limiter**. The limiter is the reusable core component.

---

## 4. Technology Stack

| Area | Technology |
|---|---|
| Runtime | Node.js |
| Language | TypeScript |
| HTTP/Gateway | Express |
| Distributed Store | Redis |
| Metrics | Prometheus |
| Visualization | Grafana |
| Logging | Pino / structured JSON logging |
| Testing | Vitest or Jest |
| Integration | Docker Compose |
| Load Testing | k6 |
| Version Control | Git |

We are choosing Node.js/TypeScript intentionally so the portfolio contains a Go backend project and a separate Node.js backend/systems project.

---

## 5. Repository Structure

```text
rate-limiter/
│
├── src/
│   │
│   ├── core/
│   │   ├── rate-limiter.ts
│   │   ├── types.ts
│   │   └── errors.ts
│   │
│   ├── algorithms/
│   │   ├── token-bucket.ts
│   │   ├── fixed-window.ts
│   │   ├── sliding-window.ts
│   │   └── leaky-bucket.ts
│   │
│   ├── stores/
│   │   ├── store.ts
│   │   ├── memory-store.ts
│   │   └── redis-store.ts
│   │
│   ├── gateway/
│   │   ├── server.ts
│   │   ├── routes.ts
│   │   ├── middleware/
│   │   │   └── rate-limit-middleware.ts
│   │   └── proxy/
│   │       └── proxy.ts
│   │
│   ├── config/
│   │   ├── index.ts
│   │   └── limits.ts
│   │
│   ├── observability/
│   │   ├── metrics.ts
│   │   └── logger.ts
│   │
│   └── app.ts
│
├── tests/
│   ├── unit/
│   │   ├── algorithms/
│   │   ├── stores/
│   │   └── core/
│   │
│   ├── integration/
│   │   ├── redis/
│   │   └── gateway/
│   │
│   └── load/
│       └── rate-limiter.js
│
├── prometheus/
│   └── prometheus.yml
│
├── grafana/
│   ├── dashboards/
│   └── provisioning/
│
├── docker/
│   └── ...
│
├── .env.example
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── README.md
└── .gitignore
```

### Dependency direction

Keep the dependency flow clean:

```text
Gateway
   ↓
RateLimiter Core
   ↓
Algorithm + Store
```

The algorithms must not depend on Express.
The core limiter must not depend on Express.
The store must not know about HTTP.
Observability should not contain business logic.

---

## 6. Core Interfaces / Responsibilities

### RateLimiter

Responsible for the orchestration of a rate-limit decision.

Expected result should eventually contain information such as:

```text
allowed
remaining
reset / retry information
limit
```

### Algorithm

Responsible for the rate-limit strategy.

Examples:

- Token Bucket
- Fixed Window
- Sliding Window Counter
- Leaky Bucket

### Store

Responsible for state persistence/retrieval.

Implement:

- In-memory storage
- Redis storage

Storage should be pluggable.

The algorithm and storage should remain independently replaceable.

---

## 7. Algorithms To Implement

### 7.1 Token Bucket

Model:

```text
Bucket capacity = C
Refill rate     = r tokens/sec

Request
  ↓
Refill based on elapsed time
  ↓
Token available?
 ├── Yes → consume token → ALLOW
 └── No  → DENY
```

Properties:

- Allows controlled bursts up to bucket capacity.
- Enforces an average refill rate.
- State typically includes token count and last-refill timestamp.

This should be one of the main production/demo algorithms.

### 7.2 Fixed Window Counter

```text
Current window
     ↓
Counter++
     ↓
Counter <= limit ?
 ├── Yes → ALLOW
 └── No  → DENY
```

Important behavior to demonstrate: the boundary-burst problem, where a client can use the full allowance near the end of one window and again near the beginning of the next.

### 7.3 Sliding Window Counter

Use the current and previous fixed windows with a weighted approximation.

Goal:

- Avoid most fixed-window boundary artifacts.
- Keep state small.

### 7.4 Leaky Bucket

Requests enter a queue and are drained at a fixed rate.

Use it mainly to demonstrate how traffic shaping differs from token bucket.

---

## 8. Storage Backends

### 8.1 In-Memory Store

Use for:

- local/single-instance deployments
- unit tests
- first-tier fallback

Must address:

- memory growth
- expired-key cleanup
- contention / synchronization

### 8.2 Redis Store

Use for distributed enforcement.

Multiple gateway instances must share the same rate-limit state:

```text
Gateway 1 ─┐
Gateway 2 ─┼──► Redis
Gateway 3 ─┘
```

The shared store is not the rate limiter itself. Redis supplies storage/atomic primitives; our code implements the algorithm and decision logic.

---

## 9. Distributed Concurrency / Atomicity

This is one of the most important parts of the project.

The unsafe pattern is:

```text
READ count
   ↓
CHECK limit
   ↓
WRITE count
```

Under concurrent requests, multiple requests may observe the same old value and all make an allow decision.

### Required principle

The complete state transition must be atomic.

Use:

- Atomic Redis commands where one operation is sufficient.
- Redis Lua scripts for multi-step algorithms such as token bucket refill/check/update.

Example conceptual flow:

```text
Node.js
   ↓
Atomic Redis operation / Lua script
   ↓
ALLOW or DENY
```

Do not split critical operations such as `increment` and `expire` into unsafe independent steps when correctness depends on them being together.

---

## 10. Rate-Limit Identity / Keys

Support configurable limiting keys such as:

- API key
- authenticated user ID
- IP address
- route / endpoint
- combinations such as `user + route`

The key-selection strategy should be explicit and testable.

IP-based limiting is useful for anonymous traffic but is not always fair because multiple users can share an IP and attackers can rotate IPs.

---

## 11. Gateway Behavior

The Express gateway will have a route flow similar to:

```text
HTTP Request
     ↓
Extract identity/key
     ↓
Resolve limit rule
     ↓
RateLimiter.check(...)
     ↓
 ┌───────────────┐
 │ Allowed?      │
 └──────┬────────┘
        │
   ┌────┴────┐
   │         │
  YES       NO
   │         │
   ▼         ▼
Proxy      HTTP 429
backend
```

For denied requests return useful rate-limit information, including where appropriate:

- `429 Too Many Requests`
- `Retry-After`
- limit information
- remaining allowance
- reset information

Allowed requests should be sent to a small downstream/dummy backend that represents an external service being protected.

---

## 12. Failure Handling / Resilience

The rate limiter sits in the critical path, so its failure behavior must be explicit.

We will support/configure strategies such as:

### Fail-open

If the limiter cannot decide, allow the request.

Pros: availability.
Cons: protection temporarily disappears.

### Fail-closed

If the limiter cannot decide, deny the request.

Pros: protection.
Cons: limiter failure can become an outage.

### Degraded fallback

Preferred demonstration path:

```text
Redis unavailable
      ↓
short timeout
      ↓
MemoryStore fallback
      ↓
Requests remain bounded per instance
```

This is weaker than fleet-wide Redis enforcement but is safer than silently removing protection.

Also ensure a slow Redis dependency does not become the main source of request latency.

---

## 13. Observability

Prometheus and Grafana are included because we want the system to be observable and measurable, not just functional.

### Prometheus

Prometheus collects/stores time-series metrics from the Node.js service by scraping the metrics endpoint.

Conceptually:

```text
Node.js
  ↓
GET /metrics
  ↓
Prometheus
```

### Grafana

Grafana connects to Prometheus and visualizes the metrics in dashboards.

```text
Prometheus
    ↓
   PromQL
    ↓
 Grafana
    ↓
Dashboards
```

Grafana is visualization; Prometheus is the metrics backend.

Neither requires Kubernetes for this project.

---

## 14. Metrics To Expose

At minimum expose metrics for:

```text
rate_limiter_requests_total
rate_limiter_decisions_total
rate_limiter_latency_seconds
rate_limiter_store_operations_total
rate_limiter_store_errors_total
rate_limiter_fallback_total
```

Useful labels can include:

```text
algorithm
route
status / decision
```

Avoid uncontrolled/high-cardinality labels such as raw user IDs for broad metrics.

### Important dashboard signals

- Requests per second
- Allowed requests
- Denied requests
- 429 responses
- Denial rate
- Limiter latency
- P95/P99 latency where useful
- Redis errors
- Redis operation latency
- Fallback/degraded-mode events

---

## 15. Grafana Dashboard Plan

### Dashboard 1 — Traffic Overview

Show:

- total request rate
- allowed rate
- denied rate
- 429 rate

### Dashboard 2 — Rate Limiter Health

Show:

- limiter latency
- Redis latency
- Redis errors
- fallback events

### Dashboard 3 — Algorithm / Client Analysis

Show where useful:

- requests by algorithm
- requests by route
- top blocked routes/clients, while avoiding dangerous high-cardinality metrics

### Dashboard 4 — Load-Test View

A dashboard specifically useful while running k6 so the rate-limit behavior can be visually observed under traffic.

---

## 16. Testing Strategy

Testing must be more than normal unit tests because the hardest problems appear under concurrent load.

### Unit tests

Test each algorithm independently:

- basic allow
- basic deny
- refill behavior
- burst behavior
- window boundaries
- remaining/reset calculations
- edge cases

### Store tests

Test:

- MemoryStore correctness
- expiry
- RedisStore behavior
- atomic operations
- failure conditions

### Integration tests

Test the complete path:

```text
HTTP request
   ↓
Express middleware
   ↓
RateLimiter
   ↓
Redis
   ↓
response
```

### Concurrency tests

Send many simultaneous requests for the same key and assert that the number of successful decisions respects the configured allowance.

Purpose: catch read-modify-write races.

### Load tests

Use k6 for realistic traffic patterns:

- steady traffic
- bursts
- many concurrent users
- high request volume
- Redis failure scenarios where practical

---

## 17. Docker Compose Infrastructure

The first complete local environment should run without Kubernetes.

Conceptual services:

```text
Client / k6
      ↓
Node.js Gateway
      ↓
Redis

Node.js ──► Prometheus ──► Grafana

Node.js Gateway ──► Dummy Backend
```

Expected local services will roughly include:

```text
Node.js gateway    : application port
Dummy backend      : separate port
Redis              : 6379
Prometheus         : 9090
Grafana            : 3000 (or another selected host port)
```

Actual port choices should be defined once in configuration and documented.

---

## 18. Development Phases

### Phase 1 — Project skeleton

- Initialize TypeScript project.
- Establish folder structure.
- Configure linting/formatting/testing.
- Create core interfaces.

### Phase 2 — In-memory limiter

Implement:

1. Fixed Window
2. Token Bucket
3. Sliding Window Counter
4. Leaky Bucket

Write unit tests for each.

### Phase 3 — Express gateway

- Add gateway server.
- Add rate-limit middleware.
- Add demo backend.
- Return `429` responses and rate-limit headers.

### Phase 4 — Redis distributed store

- Implement RedisStore.
- Make critical decisions atomic.
- Add Lua scripts where required.
- Run multiple gateway instances against one Redis instance.

### Phase 5 — Failure behavior

- Redis timeout handling.
- Fail-open / fail-closed configuration.
- Memory fallback.
- Structured degradation logs.

### Phase 6 — Prometheus instrumentation

- Add `/metrics`.
- Instrument allowed/denied counts.
- Instrument latency.
- Instrument Redis errors and fallbacks.

### Phase 7 — Grafana

- Connect Grafana to Prometheus.
- Build dashboards.
- Observe behavior during traffic tests.

### Phase 8 — Load and concurrency testing

- Build k6 scenarios.
- Test concurrency correctness.
- Test bursts.
- Test sustained load.
- Record benchmark results.

### Phase 9 — Documentation / portfolio polish

README should contain:

- problem statement
- architecture diagram
- algorithm explanations
- trade-offs
- distributed design
- failure behavior
- observability screenshots
- benchmark results
- how to run with Docker Compose
- example API calls
- design decisions

---

## 19. Important Design Principles

1. **Separate algorithm from storage.**
2. **Keep the core rate limiter independent from Express.**
3. **Make distributed state changes atomic.**
4. **Keep storage pluggable.**
5. **Make failure behavior explicit.**
6. **Use short dependency timeouts.**
7. **Prevent unbounded memory growth in local storage.**
8. **Avoid unnecessary global contention.**
9. **Return useful rejection metadata.**
10. **Instrument the system from the beginning.**
11. **Test concurrent behavior explicitly.**
12. **Choose algorithms based on traffic semantics, not preference.**

---

## 20. Algorithm Selection Mental Model

```text
Need burst tolerance?
        ↓
   Token Bucket

Need simple coarse limits?
        ↓
   Fixed Window

Need smoother / more accurate windows with low memory?
        ↓
   Sliding Window Counter

Need constant downstream output?
        ↓
   Leaky Bucket
```

The final system should make algorithm choice a configuration/deployment decision rather than hard-coding one strategy into the gateway.

---

## 21. What We Are NOT Doing Initially

Do not add Kubernetes in the first version.

Do not start by building a huge production platform.

Do not make Grafana/Prometheus the main project.

Do not tightly couple the algorithm to Redis or Express.

Do not optimize prematurely before correctness and tests are established.

The first goal is a correct, understandable limiter. Distributed correctness, resilience, observability, and benchmarking are layered on afterward.

---

## 22. Final Portfolio Goal

The finished project should be describable as:

> Built a distributed rate limiter in Node.js/TypeScript supporting multiple algorithms, Redis-backed fleet-wide enforcement, atomic concurrent decisions, graceful degradation, Prometheus metrics, Grafana dashboards, Dockerized infrastructure, and k6 load testing.

The project should demonstrate that we understand both the **algorithmic side** and the **systems side**:

```text
Rate-limit algorithm
        +
Shared distributed state
        +
Atomicity / concurrency
        +
Failure handling
        +
Observability
        +
Load testing
        =
Production-style backend system
```

---

## 23. Reference Design Notes

The accompanying rate-limiting reference document establishes the main concepts used in this project:

- rate limiting protects availability, security, fairness, and cost;
- token bucket, leaky bucket, fixed window, and sliding window are the canonical algorithms considered;
- a shared centralized store is needed for fleet-wide enforcement;
- atomicity is essential for read-check-update decisions;
- failure behavior should be explicitly designed;
- allowed/denied rates and limiter latency are important observability signals;
- concurrency/load testing is required for correctness.

These principles should guide implementation decisions throughout the project.
