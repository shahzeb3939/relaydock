FROM node:22-alpine AS build

RUN apk add --no-cache python3 make g++ && corepack enable
WORKDIR /workspace

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile
RUN pnpm prisma:generate && pnpm --filter @relaydock/protocol build && pnpm --filter @relaydock/config build && pnpm --filter @relaydock/shared build && pnpm --filter @relaydock/server build

FROM node:22-alpine AS runtime

WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=build /workspace /workspace
USER node
EXPOSE 3000
CMD ["sh", "-c", "node apps/server/node_modules/prisma/build/index.js migrate deploy && node apps/server/dist/index.js"]
