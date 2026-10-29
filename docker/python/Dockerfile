# Dev tooling image for services/scanner: pytest + ruff. The scanner's own
# runtime image is added with the scanner service itself.
FROM python:3.12-slim

RUN pip install --no-cache-dir --disable-pip-version-check pytest==8.3.4 ruff==0.8.6
WORKDIR /app
