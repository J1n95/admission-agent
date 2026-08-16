FROM node:24-bookworm-slim

WORKDIR /app
COPY . .

ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173
EXPOSE 4173
VOLUME ["/app/collector/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
