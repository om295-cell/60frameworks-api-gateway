import http from 'node:http';

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

/**
 * Helper to extract raw request body as Buffer or string
 */
async function getRequestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return undefined;
  }

  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'object') return JSON.stringify(req.body);
    if (typeof req.body === 'string') return req.body;
  }

  // Read incoming stream if available
  if (typeof req.on === 'function' && !req.readableEnded) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.length > 0 ? buffer : undefined);
      });
      req.on('error', reject);
    });
  }

  return undefined;
}

/**
 * Perform health diagnostics across all backend nodes in parallel
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

/**
 * Handle incoming requests - Main Gateway Controller
 */
export default async function handler(req, res) {
  const startTime = Date.now();

  // 1. Setup global CORS headers
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

  // 2. Handle CORS Preflight immediately
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400');
    res.statusCode = 204;
    res.end();
    return;
  }

  // Parse normalized target path and query string
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const search = parsedUrl.search;

  // 3. Diagnostics & Gateway Health Endpoint
  if (
    pathname === '/' ||
    pathname === '/health' ||
    pathname === '/gateway-health' ||
    pathname === '/gateway-status'
  ) {
    // If request asks specifically for backend root (e.g., /api/v1/health is proxied to backends)
    // Here we provide the load balancer diagnostics overview
    const diagnostics = await checkAllBackendsHealth();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 200;
    res.end(JSON.stringify(diagnostics, null, 2));
    return;
  }

  // 4. Load Balancing & Failover Retry Loop
  const bodyBuffer = await getRequestBody(req);

  // Prepare outgoing headers (removing hop-by-hop headers)
  const forwardHeaders = { ...req.headers };
  delete forwardHeaders['host'];
  delete forwardHeaders['content-length'];
  delete forwardHeaders['connection'];
  delete forwardHeaders['transfer-encoding'];
  delete forwardHeaders['accept-encoding']; // Let fetch handle decompression

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

  // Try backends in round-robin order with failover
  for (let i = 0; i < BACKENDS.length; i++) {
    const backendIndex = (startIndex + i) % BACKENDS.length;
    const targetBackend = BACKENDS[backendIndex];
    const targetUrl = `${targetBackend}${pathname}${search}`;
    attempts++;

    try {
      forwardHeaders['host'] = new URL(targetBackend).host;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s per backend attempt

      const response = await fetch(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: bodyBuffer,
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timeoutId);

      // If backend returns a 502/503/504 gateway/service error, try the next backend
      if ([502, 503, 504].includes(response.status) && i < BACKENDS.length - 1) {
        console.warn(
          `[Gateway] Backend ${targetBackend} returned ${response.status}. Failing over to next backend...`
        );
        lastError = new Error(`Backend returned HTTP ${response.status}`);
        continue;
      }

      // Success or valid client response (2xx, 3xx, 4xx)
      res.statusCode = response.status;

      // Copy response headers
      response.headers.forEach((value, key) => {
        // Skip certain headers that shouldn't be duplicated or conflict
        const lowerKey = key.toLowerCase();
        if (
          lowerKey !== 'content-encoding' &&
          lowerKey !== 'transfer-encoding' &&
          lowerKey !== 'access-control-allow-origin'
        ) {
          res.setHeader(key, value);
        }
      });

      // Add custom diagnostics headers
      const durationMs = Date.now() - startTime;
      res.setHeader('X-Backend-Routed', targetBackend);
      res.setHeader('X-Backend-Attempt', attempts.toString());
      res.setHeader('X-Response-Time', `${durationMs}ms`);

      const arrayBuffer = await response.arrayBuffer();
      res.end(Buffer.from(arrayBuffer));
      return;
    } catch (err) {
      console.error(
        `[Gateway] Error forwarding to ${targetBackend} (${err.message}). Attempting failover...`
      );
      lastError = err;
    }
  }

  // All backend attempts failed
  const durationMs = Date.now() - startTime;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 502;
  res.end(
    JSON.stringify({
      success: false,
      error: 'Bad Gateway - All backend instances are unreachable or timed out',
      details: lastError ? lastError.message : 'Unknown gateway error',
      attempts,
      durationMs,
      timestamp: new Date().toISOString(),
    })
  );
}

// Standalone server for local development and testing
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('api/index.js') || process.argv[1].endsWith('api\\index.js'));

if (isDirectRun || process.env.STANDALONE === 'true') {
  const PORT = process.env.PORT || 8080;
  const server = http.createServer(handler);
  server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 60Frameworks API Gateway running at http://localhost:${PORT}`);
    console.log(`⚖️  Active Load-Balanced Backends:`);
    BACKENDS.forEach((b, i) => console.log(`   [${i + 1}] ${b}`));
    console.log(`======================================================\n`);
  });
}
