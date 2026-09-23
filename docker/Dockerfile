FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node-deps
WORKDIR /workspace
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN npm ci --no-audit --no-fund

FROM node-deps AS js-build
COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
COPY apps/web ./apps/web
RUN npm run build:contracts && npm run build --workspace @money-graph/api

# Prune only an isolated runtime stage: builds/tests still use full node-deps.
# Playwright is also an optional Next peer (devOptional in the shared lockfile),
# so omit optional packages as well; the API declares its runtime deps explicitly.
FROM js-build AS api-production-deps
RUN npm prune --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund

FROM js-build AS web-build
ARG NEXT_PUBLIC_API_URL=http://localhost:3001/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build --workspace @money-graph/web

FROM python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e AS python-runtime
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /workspace
RUN python -m venv /opt/venv
COPY analytics/requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir -r /tmp/requirements.lock
COPY analytics ./analytics
RUN pip install --no-cache-dir --no-deps ./analytics

FROM python-runtime AS analytics
CMD ["python", "-m", "money_graph", "--help"]

FROM python-runtime AS api
COPY --from=node-deps /usr/local/bin/node /usr/local/bin/node
COPY --from=api-production-deps /workspace/node_modules ./node_modules
COPY --from=api-production-deps /workspace/apps/api ./apps/api
COPY --from=api-production-deps /workspace/packages/contracts ./packages/contracts
# Assert the actual final dependency tree, including nested workspace packages.
RUN node -e "const fs = require('node:fs'), path = require('node:path'); \
  const forbidden = new Set(['@playwright/test', 'playwright', 'playwright-core', 'typescript', 'tsx']); \
  const check = directory => { \
    if (!fs.existsSync(directory)) return; \
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { \
      if (!entry.isDirectory()) continue; \
      const location = path.join(directory, entry.name); \
      if (entry.name.startsWith('@')) { check(location); continue; } \
      const manifest = path.join(location, 'package.json'); \
      if (fs.existsSync(manifest) && forbidden.has(JSON.parse(fs.readFileSync(manifest, 'utf8')).name)) \
        throw new Error('Test/build dependency present in API runtime: ' + location); \
      check(path.join(location, 'node_modules')); \
    } \
  }; \
  for (const directory of ['node_modules', 'apps/api/node_modules', 'packages/contracts/node_modules']) check(directory);"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]

# Test-only stages. Production API/web/CLI contracts are unchanged.
FROM python-runtime AS acceptance-python
COPY scripts/acceptance ./scripts/acceptance
COPY docs ./docs
COPY README.md ./
CMD ["python", "scripts/acceptance/pipeline.py", "--input-dir", "/data", "--report-dir", "/reports", "--mode", "official"]

FROM js-build AS acceptance-js
ENV NODE_ENV=test
COPY scripts/acceptance ./scripts/acceptance
COPY scripts/tests/acceptance-runner.test.mjs ./scripts/tests/acceptance-runner.test.mjs
COPY docker/compose.acceptance.yaml ./docker/compose.acceptance.yaml
CMD ["sh", "-c", "node --test scripts/tests/acceptance-runner.test.mjs && npm run test --workspace @money-graph/api && npm run test:web && npm run typecheck && npm run typecheck:acceptance"]

FROM node-deps AS acceptance-browser
ENV CI=true NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# Install only Chromium, using the exact Playwright version in package-lock.json.
# Do not depend on the much larger multi-browser image from a separate registry.
RUN node node_modules/@playwright/test/cli.js install --with-deps chromium
COPY packages/contracts ./packages/contracts
COPY tsconfig.base.json ./
COPY scripts/acceptance ./scripts/acceptance
CMD ["node", "node_modules/@playwright/test/cli.js", "test", "--config=scripts/acceptance/playwright.config.ts"]

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS web
WORKDIR /workspace
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=web-build /workspace/apps/web/.next/standalone ./
COPY --from=web-build /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build /workspace/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
