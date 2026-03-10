FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev \
  && npx playwright install --with-deps chromium \
  && npm cache clean --force

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./package.json
RUN mkdir -p /data/screenshots /data/tokens \
  && chown -R node:node /app /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const http=require('node:http');const req=http.get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',(res)=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));"
CMD ["node", "dist/src/index.js"]
