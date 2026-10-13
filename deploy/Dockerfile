# deploy/Dockerfile — the gateway image. Build from the repository root:
#   docker build -f deploy/Dockerfile -t marg-gateway .
# No build step (tsx runs TypeScript directly); runs as a non-root user; health on /api/health.
FROM node:22-alpine
WORKDIR /app
RUN addgroup -S agent && adduser -S agent -G agent
COPY --chown=agent:agent package.json package-lock.json tsconfig.json ./
COPY --chown=agent:agent packages ./packages
COPY --chown=agent:agent examples ./examples
COPY --chown=agent:agent domains ./domains
COPY --chown=agent:agent shared-skills ./shared-skills
# tsx is a devDependency: keep dev deps in the image, then run as production.
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force \
  && mkdir -p .data && chown -R agent:agent .data examples
ENV NODE_ENV=production
USER agent
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "packages/gateway/src/server.ts"]
