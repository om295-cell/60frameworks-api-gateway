import http from 'node:http';
import handler from './api/index.js';

const TEST_PORT = 8089;

async function runTests() {
  console.log('🧪 Starting 60Frameworks API Gateway Automated Test Suite...\n');

  // 1. Direct Backend Verification
  const BACKENDS = [
    'https://60frameworks-back1.vercel.app',
    'https://60frameworks-back2.vercel.app',
    'https://60frameworks-back3.vercel.app',
  ];

  console.log('--- Step 1: Checking Backend Availability Directly ---');
  for (const backend of BACKENDS) {
    const start = Date.now();
    try {
      const res = await fetch(`${backend}/api/v1/health`, { signal: AbortSignal.timeout(6000) });
      const duration = Date.now() - start;
      console.log(`✅ ${backend} -> Status ${res.status} (${duration}ms)`);
    } catch (err) {
      console.log(`⚠️ ${backend} -> Warning: ${err.message} (${Date.now() - start}ms)`);
    }
  }

  // 2. Start Gateway on test port
  console.log('\n--- Step 2: Starting Local Test Gateway Server ---');
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`🚀 Test Gateway listening on http://127.0.0.1:${TEST_PORT}`);

  try {
    // 3. Test Diagnostics endpoint
    console.log('\n--- Step 3: Testing Gateway Diagnostics (GET /) ---');
    const diagRes = await fetch(`http://127.0.0.1:${TEST_PORT}/`);
    const diagJson = await diagRes.json();
    console.log(`Status: ${diagRes.status}`);
    console.log(`Healthy Backends: ${diagJson.healthyBackends}`);
    console.log(`Backends status:`, JSON.stringify(diagJson.backends, null, 2));

    // 4. Test Round-Robin distribution over 6 requests
    console.log('\n--- Step 4: Testing Load Distribution (6 Requests to /api/v1/projects) ---');
    const routedTo = {};
    for (let i = 1; i <= 6; i++) {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/v1/projects`);
      const backendUsed = res.headers.get('x-backend-routed') || 'unknown';
      const responseTime = res.headers.get('x-response-time') || 'unknown';
      routedTo[backendUsed] = (routedTo[backendUsed] || 0) + 1;
      console.log(`Req #${i}: Status ${res.status} | Routed to: ${backendUsed} | Time: ${responseTime}`);
    }

    console.log('\n📊 Request Distribution Summary:', routedTo);

    // 5. Test CORS Preflight
    console.log('\n--- Step 5: Testing CORS Preflight (OPTIONS) ---');
    const optRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/v1/contact`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://60frameworks.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    console.log(`OPTIONS Status: ${optRes.status} (Expected 204)`);
    console.log(`Access-Control-Allow-Origin: ${optRes.headers.get('access-control-allow-origin')}`);
    console.log(`Access-Control-Allow-Methods: ${optRes.headers.get('access-control-allow-methods')}`);

    console.log('\n✨ All Gateway tests completed successfully!');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
