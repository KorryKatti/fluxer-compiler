FROM oven/bun:1-alpine

WORKDIR /app

# Install deps first (cached layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY . .

ENV NODE_ENV=production

CMD ["bun", "run", "src/index.ts"]
