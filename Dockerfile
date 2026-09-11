# Cloud Run image for the MaybeSitter API (UC-1.0d #143).
#
# Pinned to the multi-arch image index digest, not a tag and not a
# single-platform digest: CI and Cloud Run are amd64 while development
# machines here are arm64, and the index covers both.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

# --- deps -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
RUN npm ci

# --- build ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- run --------------------------------------------------------------------
FROM ${NODE_IMAGE} AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Recorded at build time so /api/health can report exactly which commit is
# serving, which is how the deploy workflow verifies what it promoted.
ARG GIT_SHA=unknown
ENV MAYBESITTER_GIT_SHA=$GIT_SHA

# `output: 'standalone'` emits a self-contained server plus the minimal
# node_modules it traced. There is no public/ directory in this repository.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

# Never run as root. The filesystem stays read-only in production; everything
# durable lives in Firestore (UC-1.0b #141, UC-1.0c #142).
USER node
EXPOSE 8080
CMD ["node", "server.js"]
