FROM node:24.22.2-bookworm-slim
# Python is retained only for the separate legacy research CLI and its regression suite.
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/checkpoint && chown 1000:1000 /data/checkpoint && chmod 700 /data/checkpoint
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data/checkpoint PYTHONDONTWRITEBYTECODE=1
COPY --chown=node:node checkpoint ./checkpoint
COPY --chown=node:node product ./product
COPY --chown=node:node web ./web
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node server.mjs package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready',{signal:AbortSignal.timeout(2000)}).then(r=>{process.exitCode=r.ok?0:1}).catch(()=>{process.exitCode=1})"]
STOPSIGNAL SIGTERM
CMD ["node", "scripts/launch.mjs"]
