# Upload validation service. Default target (`runtime`): the service itself, as an
# unprivileged user. `dev` adds pytest and Ruff for the python-tools container.
FROM python:3.12-slim AS base

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
