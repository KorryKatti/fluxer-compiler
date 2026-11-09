FROM oven/bun:1-alpine

WORKDIR /app

# Install deps first (cached layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source, owned by the non-root bun user (uid 1000)
COPY --chown=bun:bun . .


RUN mkdir -p /app/data && chown bun:bun /app/data

ENV NODE_ENV=production \
    HOME=/home/bun \
    DATA_DIR=/app/data

USER bun

CMD ["bun", "run", "src/index.ts"]
