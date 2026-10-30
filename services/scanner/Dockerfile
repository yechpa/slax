# Upload validation service. Default target (`runtime`): the service itself, as an
# unprivileged user, and the production image ghcr.io/yechpa/slax-scanner (read-only root
# filesystem friendly: it only writes to /tmp). `dev` adds pytest and Ruff for the
# python-tools container. The base image is pinned by version and digest (a multi-architecture
# index: the same line builds linux/amd64 and linux/arm64).
ARG PYTHON_IMAGE=python:3.12.16-slim-trixie@sha256:8523d6abeb48ceae0b7240d30c5808fc26cb79c1a635bacdf19cf3baecfbec07
FROM ${PYTHON_IMAGE} AS base

# libmagic: content sniffing for python-magic.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libmagic1 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

FROM base AS dev
COPY requirements-dev.txt .
RUN pip install -r requirements-dev.txt

FROM base AS runtime
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin scanner
COPY app ./app
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header", "--limit-concurrency", "32", "--timeout-keep-alive", "5"]
