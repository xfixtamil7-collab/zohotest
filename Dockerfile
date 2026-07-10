# Base node image
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Install dependencies needed for compiling prisma (if any native bindings)
RUN apk add --no-cache openssl

# Copy package.json and lockfile
COPY package*.json ./

# Install development and production dependencies
RUN npm ci

# Copy configuration files and source code
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

# Generate Prisma client and build project
RUN npx prisma generate
RUN npm run build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

RUN apk add --no-cache openssl

COPY package*.json ./
# Install only production dependencies
RUN npm ci --only=production

# Copy built assets and prisma schema from builder
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/prisma ./prisma
COPY --from=builder /usr/src/app/src/public ./dist/public

# Generate prisma client for runner environment
RUN npx prisma generate

EXPOSE 3000

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
