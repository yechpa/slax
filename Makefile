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
.PHONY: help env deps up down logs ps migrate shell test test-reverb lint fmt screenshots e2e chart-lint images

help: ## Show this help
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-11s %s\n", $$1, $$2}'

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
	$(RUN) app php artisan db:seed --class=DemoSeeder --force
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
	$(RUN) --no-deps frontend npx vite build --mode design-system --logLevel warn
	docker run --rm --user $(DOCKER_UID):$(DOCKER_GID) -e HOME=/tmp \
		-v $(CURDIR)/frontend/dist-design-system:/dist:ro -v $(CURDIR)/frontend/scripts:/scripts:ro -v $(CURDIR)/docs/design:/out \
		$(PLAYWRIGHT_IMAGE) sh -c 'npm install --silent --no-audit --no-fund --prefix /tmp/pw playwright-core@1.64.1 \
		&& PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core/index.mjs node /scripts/design-screenshots.mjs'

# The end-to-end stack: its own Compose project (fresh volumes, nothing published on the host),
# configured from e2e/stack.env alone, APP_ENV=e2e. See docker-compose.e2e.yml.
DCE := $(DC) -p slax-e2e --env-file e2e/stack.env -f docker-compose.yml -f docker-compose.e2e.yml

e2e: env deps ## Run the Playwright end-to-end suite on a fresh, separate stack (APP_ENV=e2e), then remove it
	set -e; \
	export APP_KEY="base64:$$(openssl rand -base64 32)"; \
	trap '$(DCE) --profile e2e down -v --remove-orphans' EXIT; \
	$(DCE) --profile e2e down -v --remove-orphans; \
	echo '==> Building the e2e bundle'; \
	$(DCE) run --rm -T --no-deps -e NPM_CONFIG_UPDATE_NOTIFIER=false frontend npx vite build --mode e2e --logLevel warn; \
	echo '==> Starting the e2e stack'; \
	$(DCE) up -d --build --quiet-build --wait app reverb queue web scanner minio; \
	$(DCE) run --rm -T minio-private; \
	$(DCE) exec -T app php artisan migrate --force --no-interaction --quiet; \
	$(DCE) exec -T app php artisan db:seed --class=DefaultWorkspaceSeeder --force --no-interaction --quiet; \
	echo '==> Playwright'; \
	mkdir -p docs/design/e2e; \
	$(DCE) run --rm -T playwright

# Helm chart checks (deploy/helm/slax), all in pinned containers: helm lint, the dev and prod
# renders validated against the Kubernetes 1.36 schemas (kubeconform; cert-manager and Traefik
# resources against the CRDs catalog), then the chart's own rules (deploy/helm/check-chart.sh).
HELM_IMAGE := alpine/helm:3.22.1@sha256:8191701ad1f82ee3695c87211fcbfe6d7b1bb7df92ac1c8de9ccdb0995a6a2c1
KUBECONFORM_IMAGE := ghcr.io/yannh/kubeconform:v0.8.0@sha256:faffaf43f95aa6425306e1ab8d6fcad72acb9049158f38e574c085ea1ec0f64e
YQ_IMAGE := mikefarah/yq:4.54.1@sha256:4b3d9475d65571d28cbb19544d3820ec2945e4c8b2f18279394282b8dc3a592e
CHART := deploy/helm/slax
CHART_OUT := build/chart
CHART_RUN = docker run --rm -u $(DOCKER_UID):$(DOCKER_GID) -e HOME=/tmp -v $(CURDIR):/repo -w /repo
HELM = $(CHART_RUN) $(HELM_IMAGE)
KUBECONFORM = $(CHART_RUN) $(KUBECONFORM_IMAGE) -strict -summary -kubernetes-version 1.36.0 \
	-schema-location default \
	-schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

chart-lint: ## Lint, render and validate the Helm chart (dev and prod values)
	set -e; mkdir -p $(CHART_OUT); \
	for env in dev prod; do \
		echo "==> helm lint ($$env)"; \
		$(HELM) lint --strict --quiet $(CHART) -f $(CHART)/values-$$env.yaml --set image.tag=0123abc; \
		$(HELM) template slax $(CHART) -n slax -f $(CHART)/values-$$env.yaml --set image.tag=0123abc > $(CHART_OUT)/$$env.yaml; \
	done; \
	echo '==> helm template refuses unsafe values'; \
	! $(HELM) template slax $(CHART) -f $(CHART)/values-dev.yaml > /dev/null 2>&1 || { echo 'rendered without image.tag'; exit 1; }; \
	! $(HELM) template slax $(CHART) -f $(CHART)/values-dev.yaml --set image.tag=x --set config.extraEnv.APP_ENV=local > /dev/null 2>&1 || { echo 'rendered APP_ENV=local'; exit 1; }; \
	! $(HELM) template slax $(CHART) -f $(CHART)/values-dev.yaml --set image.tag=x --set config.extraEnv.APP_KEY=x > /dev/null 2>&1 || { echo 'rendered a secret in the ConfigMap'; exit 1; }; \
	echo '==> kubeconform'; \
	$(KUBECONFORM) $(CHART_OUT)/dev.yaml $(CHART_OUT)/prod.yaml deploy/dev/deployer-rbac.yaml deploy/dev/cluster-issuer.example.yaml; \
	echo '==> chart rules'; \
	$(CHART_RUN) --entrypoint sh $(YQ_IMAGE) deploy/helm/check-chart.sh $(CHART_OUT)/dev.yaml $(CHART_OUT)/prod.yaml

# The three production images, as CI builds them (native architecture only here).
images: ## Build the production images slax-app, slax-web and slax-scanner (tag :local)
	docker build -q -f docker/app/Dockerfile -t slax-app:local .
	docker build -q -f docker/web/Dockerfile -t slax-web:local .
	docker build -q --target runtime -t slax-scanner:local services/scanner
	docker image ls --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep -E '^slax-(app|web|scanner):local '
