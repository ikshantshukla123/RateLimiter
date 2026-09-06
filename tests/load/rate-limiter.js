import http from 'k6/http';
import { check, sleep } from 'k6';

/**
 * k6 load suite for the rate-limiter gateway.
 *
 * Run:  BASE_URL=http://localhost:3000 k6 run tests/load/rate-limiter.js
 * Watch live: Grafana "Rate Limiter - Load Test" dashboard (host :3002).
 *
 * Scenarios:
 *   steady - normal traffic, mostly allowed
 *   burst  - sudden spike, expect sharp 429 cliff (bucket drains)
 *   soak   - sustained load, denial rate should stabilize
 */
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-vus',
      vus: 10,
      duration: '1m',
      startTime: '0s',
      tags: { scenario: 'steady' },
    },
    burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      startTime: '70s',
      stages: [
        { duration: '10s', target: 100 },
        { duration: '30s', target: 100 },
        { duration: '10s', target: 0 },
      ],
      tags: { scenario: 'burst' },
    },
    soak: {
      executor: 'constant-vus',
      vus: 20,
      duration: '2m',
      startTime: '130s',
      tags: { scenario: 'soak' },
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    'checks{expected:status}': ['rate>0.99'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/data`, { tags: { endpoint: 'api-data' } });
  const ok = check(
    res,
    {
      'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
      'no 5xx': (r) => r.status < 500,
      'rate-limit headers present': (r) => r.headers['X-Ratelimit-Limit'] !== undefined,
      '429 carries retry-after': (r) => r.status !== 429 || r.headers['Retry-After'] !== undefined,
    },
    { expected: 'status' },
  );
  if (!ok) console.error(`unexpected response: ${res.status} ${res.body?.slice?.(0, 120)}`);
  sleep(res.status === 429 ? 0.5 : 0.1);
}

export function handleSummary(data) {
  const denied = data.metrics['http_reqs']?.values?.count ?? 0;
  return {
    stdout: JSON.stringify(
      { checks: data.metrics.checks?.values, http_req_duration: data.metrics.http_req_duration?.values, total_reqs: denied },
      null,
      2,
    ),
  };
}
