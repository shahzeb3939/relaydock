.PHONY: bootstrap postgres migrate dev agent test typecheck build format docker-up docker-down

bootstrap:
	cp -n .env.example .env || true
	pnpm install
	pnpm prisma:generate

postgres:
	docker compose up -d postgres

migrate:
	pnpm prisma:migrate

dev:
	pnpm dev

agent:
	cd apps/agent && go run ./cmd/relaydock-agent run --server http://localhost:3000

test:
	pnpm test

typecheck:
	pnpm typecheck

build:
	pnpm build

format:
	pnpm format

docker-up:
	docker compose --profile app up -d --build

docker-down:
	docker compose --profile app down
