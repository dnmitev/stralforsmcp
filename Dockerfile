# syntax=docker/dockerfile:1
# Build stage: production dependencies only, on the build platform (no emulation; deps are pure JS).
FROM --platform=$BUILDPLATFORM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# --ignore-scripts: the "prepare" hook (git hooks) and dependency install scripts never run here.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

# Runtime: distroless Node 26, non-root (uid 65532), no shell. Entrypoint of the base image is node.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:767ffb7e2ffa9f4280f1af7b99f7f0a1cafb79d0dcc0e0d3aba43843748008a5
ARG VERSION=0.0.0
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/dnmitev/stralforsmcp" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="stralforsmcp" \
      org.opencontainers.image.description="MCP server for the Stralfors output-management API" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=65532:65532 --from=deps /app/node_modules ./node_modules
COPY --chown=65532:65532 package.json ./
COPY --chown=65532:65532 src ./src
USER 65532:65532
EXPOSE 3000 9464
CMD ["src/server/main.ts"]
