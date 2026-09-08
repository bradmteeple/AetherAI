# Runs the AetherAI control panel (and, when switched on, the bot itself).
# Build: docker build -t aetherai .
# Run:   docker run -p 8080:8080 -e CONTROL_PASSWORD=... -v aether:/data aetherai
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY teams ./teams

# Accounts, settings and set records live on the mounted volume.
ENV CONTROL_HOST=0.0.0.0 \
    CONTROL_PORT=8080 \
    CONTROL_STATE_FILE=/data/control.json \
    RUNS_DIR=/data/runs
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CONTROL_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/cli.js", "control"]
