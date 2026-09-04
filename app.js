import express from 'express';

const app = express();

// Configurable backends list via environment variables or default production URLs
const DEFAULT_BACKENDS = [
  'https://60frameworks-back1.vercel.app',
  'https://60frameworks-back2.vercel.app',
  'https://60frameworks-back3.vercel.app',
];

const BACKENDS = process.env.BACKENDS
  ? process.env.BACKENDS.split(',').map((url) => url.trim().replace(/\/+$/, ''))
  : DEFAULT_BACKENDS;

// Serverless cold-start resilient counter with randomized initial offset
let requestCounter = Math.floor(Math.random() * BACKENDS.length);

// Trust proxy for load balancer / edge
app.set('trust proxy', 1);

// Capture raw body for all content types without mutating payloads
app.use(
  express.raw({
    type: '*/*',
    limit: '25mb',
  })
);

/**
 * Health diagnostics across all backend nodes in parallel
 */
async function checkAllBackendsHealth() {
  const results = await Promise.allSettled(
    BACKENDS.map(async (backendUrl) => {
      const startTime = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      try {
        const res = await fetch(`${backendUrl}/api/v1/health`, {
          method: 'GET',
          headers: { 'User-Agent': '60Frameworks-Gateway-HealthCheck/1.0' },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const latencyMs = Date.now() - startTime;
        let data = null;
        try {
          data = await res.json();
        } catch {
          // ignore non-json
        }

        return {
          url: backendUrl,
          status: res.ok ? 'UP' : 'DEGRADED',
          statusCode: res.status,
          latencyMs,
          database: data?.database?.status || 'unknown',
          uptime: data?.uptime || 0,
        };
      } catch (err) {
        clearTimeout(timeoutId);
        return {
          url: backendUrl,
          status: 'DOWN',
          statusCode: null,
          latencyMs: Date.now() - startTime,
          error: err.message || 'Connection failed',
        };
      }
    })
  );

  const backendStatuses = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { url: BACKENDS[i], status: 'DOWN', error: r.reason?.message || 'Unknown error' }
  );

  const healthyCount = backendStatuses.filter((b) => b.status === 'UP').length;

  return {
    gateway: 'operational',
    timestamp: new Date().toISOString(),
    loadBalancingStrategy: 'Round-Robin with Automatic Failover',
    healthyBackends: `${healthyCount}/${BACKENDS.length}`,
    backends: backendStatuses,
  };
}

// Global CORS Middleware
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With, x-admin-token, Range, Origin, Accept'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Range, X-Backend-Routed, X-Backend-Attempt, X-Response-Time'
  );

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  next();
});

// Root / Health Diagnostics Route
app.get(['/', '/health', '/gateway-health', '/gateway-status'], async (req, res) => {
  const diagnostics = await checkAllBackendsHealth();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json(diagnostics);
});

// Catch-all Proxy Route
app.all('*', async (req, res) => {
  const startTime = Date.now();
  const parsedUrl = new URL(req.originalUrl || req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const search = parsedUrl.search;

  // Prepare outgoing body
  let bodyPayload = undefined;
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      bodyPayload = req.body;
    } else if (typeof req.body === 'string' && req.body.length > 0) {
      bodyPayload = req.body;
    } else if (typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      bodyPayload = JSON.stringify(req.body);
    }
  }

  // Prepare outgoing headers
  const forwardHeaders = { ...req.headers };
  delete forwardHeaders['host'];
  delete forwardHeaders['content-length'];
  delete forwardHeaders['connection'];
  delete forwardHeaders['transfer-encoding'];
  delete forwardHeaders['accept-encoding'];

  forwardHeaders['x-forwarded-for'] =
    req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
  forwardHeaders['x-forwarded-host'] = req.headers['host'] || '';
  forwardHeaders['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'https';
  forwardHeaders['x-gateway-balancer'] = '60frameworks-api-gateway';

  // Determine starting backend index using round-robin
  const startIndex = requestCounter % BACKENDS.length;
  requestCounter = (requestCounter + 1) % 1000000;

  let lastError = null;
  let attempts = 0;

  for (let i = 0; i < BACKENDS.length; i++) {
    const backendIndex = (startIndex + i) % BACKENDS.length;
    const targetBackend = BACKENDS[backendIndex];
    const targetUrl = `${targetBackend}${pathname}${search}`;
    attempts++;

    try {
      forwardHeaders['host'] = new URL(targetBackend).host;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s timeout

      const response = await fetch(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: bodyPayload,
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timeoutId);

      // Failover if 502/503/504
      if ([502, 503, 504].includes(response.status) && i < BACKENDS.length - 1) {
        console.warn(
          `[Gateway] Backend ${targetBackend} returned ${response.status}. Retrying next backend...`
        );
        lastError = new Error(`Backend returned HTTP ${response.status}`);
        continue;
      }

      // Copy response headers
      response.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey !== 'content-encoding' &&
          lowerKey !== 'transfer-encoding' &&
          lowerKey !== 'access-control-allow-origin'
        ) {
          res.setHeader(key, value);
        }
      });

      const durationMs = Date.now() - startTime;
      res.setHeader('X-Backend-Routed', targetBackend);
      res.setHeader('X-Backend-Attempt', attempts.toString());
      res.setHeader('X-Response-Time', `${durationMs}ms`);

      res.status(response.status);
      const arrayBuffer = await response.arrayBuffer();
      return res.send(Buffer.from(arrayBuffer));
    } catch (err) {
      console.error(
        `[Gateway] Error forwarding to ${targetBackend} (${err.message}). Attempting failover...`
      );
      lastError = err;
    }
  }

  // If all attempts failed
  const durationMs = Date.now() - startTime;
  return res.status(502).json({
    success: false,
    error: 'Bad Gateway - All backend instances are unreachable or timed out',
    details: lastError ? lastError.message : 'Unknown gateway error',
    attempts,
    durationMs,
    timestamp: new Date().toISOString(),
  });
});

export default app;
