# 60Frameworks API Gateway & Load Balancer

Production-grade API Gateway for the **60Frameworks** architecture. Distributes incoming client traffic evenly across 3 high-availability backend deployments on Vercel with automatic failover, health diagnostics, and CORS management.

## 🏛️ Architecture

```text
               https://60frameworks.com (Wix DNS / Vercel)
                             │
                             ▼
                    60frameworks-front1
                             │
                     (API Requests)
                             ▼
               https://api.60frameworks.com
                 (60frameworks-api-gateway)
                 ┌───────────┼───────────┐
                 ▼           ▼           ▼
               Back1       Back2       Back3
              (Vercel)    (Vercel)    (Vercel)
                 └───────────┬───────────┘
                             ▼
                     MongoDB Atlas DB
```

---

## 🚀 Key Features

1. **Round-Robin Load Distribution**: Distributes requests equally across `Back1`, `Back2`, and `Back3`.
2. **Cold-Start Resilience**: Random offset seeding ensures serverless instances distribute load uniformly even during rapid scale-up.
3. **Automatic Failover**: If any backend node experiences a 502/503/504 error or timeout, the gateway transparently retries the next healthy node before failing.
4. **Live Health & Diagnostics**: Querying `/` or `/health` on the gateway pings all backends concurrently and returns real-time latency, database connection status, and uptime stats.
5. **Universal CORS Handling**: Built-in preflight (OPTIONS) cache and origin matching for `60frameworks.com` and `60frameworks-front1.vercel.app`.
6. **Tracing Headers**: Injects `X-Backend-Routed`, `X-Backend-Attempt`, and `X-Response-Time` into responses for monitoring.

---

## 🛠️ Testing Locally

```bash
# Run automated validation test
node test-gateway.js

# Run local gateway server
npm start
```

---

## 📦 Deployment Instructions

1. Push these files to GitHub repository: `om295-cell/60frameworks-api-gateway`
2. Vercel automatically builds and deploys to `https://60frameworks-api-gateway.vercel.app`
3. In Vercel Project Settings for `60frameworks-api-gateway` -> Domains:
   - Add `api.60frameworks.com`
4. In Wix DNS Management:
   - Add CNAME record: `api` -> `<Vercel CNAME Target>`
5. In Frontend (`60frameworks-front1`):
   - Set environment variable: `VITE_API_BASE_URL=https://api.60frameworks.com/api/v1`
