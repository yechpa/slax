# Slax developer entry points. Everything runs in Docker; the host only needs
# docker (with the compose plugin), make and openssl.

export DOCKER_UID := $(shell id -u)
export DOCKER_GID := $(shell id -g)

DC  := docker compose --progress quiet

.SILENT:
RUN := $(DC) run --rm -T
# The scanner's tooling image is rebuilt when its pinned requirements change (cached otherwise).
PYRUN := $(RUN) --build --quiet-build python-tools

.DEFAULT_GOAL := help
.PHONY: help env deps up down logs ps migrate shell test test-reverb lint fmt screenshots

help: ## Show this help
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-8s %s\n", $$1, $$2}'

env: ## Create .env from .env.example (with a generated APP_KEY) if missing
	@test -f .env || { \
		cp .env.example .env && \
		sed -i "s|^APP_KEY=.*|APP_KEY=base64:$$(openssl rand -base64 32)|" .env && \
		echo "Created .env"; }

backend/vendor/autoload.php: backend/composer.lock | env
	$(RUN) --no-deps app composer install --no-interaction --no-progress --quiet

frontend/node_modules/.package-lock.json: frontend/package-lock.json | env
	$(RUN) --no-deps frontend npm ci --no-audit --no-fund --silent

deps: backend/vendor/autoload.php frontend/node_modules/.package-lock.json ## Install PHP and JS dependencies

up: env deps ## Start the whole stack on http://localhost:8080
	$(DC) up -d --build
	$(RUN) app php artisan migrate --force
	$(RUN) app php artisan db:seed --class=DefaultWorkspaceSeeder --force
	printf 'Waiting for the app'; \
	for i in $$(seq 1 60); do \
		curl -fsS -o /dev/null http://localhost:$${WEB_PORT:-8080}/api/v1/health 2>/dev/null && break; \
		printf '.'; sleep 1; \
	done; echo
	@echo "Slax is up: http://localhost:$${WEB_PORT:-8080} (health: /api/v1/health)"

down: ## Stop the stack (data volumes are kept)
	$(DC) --profile tools down

logs: ## Follow the logs of all services
	docker compose logs -f --tail=50

ps: ## List running services
	docker compose ps

migrate: ## Run database migrations
	$(RUN) app php artisan migrate --force

shell: ## Open a shell in the app container
	docker compose exec app sh

test: env deps ## Run Pest, Vitest and pytest
	$(DC) up -d --wait postgres redis
	$(DC) exec -T postgres sh -c 'psql -U "$$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '"'"'slax_test'"'"'" | grep -q 1 || createdb -U "$$POSTGRES_USER" slax_test'
	echo '==> Pest (backend)'; $(RUN) app vendor/bin/pest
	echo '==> Vitest (frontend)'; $(RUN) --no-deps frontend npm test --silent
	echo '==> pytest (scanner)'; $(PYRUN) pytest -q

test-reverb: env deps ## Run the end-to-end WebSocket tests against the dev Reverb server
	$(DC) up -d --wait postgres redis
	$(DC) up -d reverb
	$(DC) exec -T postgres sh -c 'psql -U "$$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '"'"'slax_test'"'"'" | grep -q 1 || createdb -U "$$POSTGRES_USER" slax_test'
	$(RUN) -e REVERB_E2E=1 app vendor/bin/pest --group=reverb-e2e

lint: env deps ## Run Pint, ESLint and Ruff (checks only)
	echo '==> Pint (backend)'; $(RUN) --no-deps app vendor/bin/pint --test
	echo '==> ESLint (frontend)'; $(RUN) --no-deps frontend npm run lint --silent
	echo '==> Ruff (scanner)'; $(PYRUN) ruff check . && $(PYRUN) ruff format --check .

fmt: env deps ## Fix formatting with Pint and Ruff
	$(RUN) --no-deps app vendor/bin/pint
	$(PYRUN) ruff check --fix .
	$(PYRUN) ruff format .

PLAYWRIGHT_IMAGE := mcr.microsoft.com/playwright:v1.64.1-noble

screenshots: env deps ## Capture the design-system kitchen sink (2 themes x 3 languages) into docs/design
	$(RUN) --no-deps frontend npx vite build --logLevel warn
	docker run --rm --user $(DOCKER_UID):$(DOCKER_GID) -e HOME=/tmp \
		-v $(CURDIR)/frontend/dist:/dist:ro -v $(CURDIR)/frontend/scripts:/scripts:ro -v $(CURDIR)/docs/design:/out \
		$(PLAYWRIGHT_IMAGE) sh -c 'npm install --silent --no-audit --no-fund --prefix /tmp/pw playwright-core@1.64.1 \
		&& PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core/index.mjs node /scripts/design-screenshots.mjs'
