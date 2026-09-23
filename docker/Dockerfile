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
COPY --from=js-build /workspace/node_modules ./node_modules
COPY --from=js-build /workspace/apps/api ./apps/api
COPY --from=js-build /workspace/packages/contracts ./packages/contracts
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS web
WORKDIR /workspace
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=web-build /workspace/apps/web/.next/standalone ./
COPY --from=web-build /workspace/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
