# Official Node image tag checked against Docker Hub's official image catalog.
FROM node:24.22.2-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY --chown=node:node checkpoint ./checkpoint
COPY --chown=node:node web ./web
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node server.mjs package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready',{signal:AbortSignal.timeout(2000)}).then(r=>{process.exitCode=r.ok?0:1}).catch(()=>{process.exitCode=1})"]
STOPSIGNAL SIGTERM
CMD ["node", "server.mjs"]
