# syntax=docker/dockerfile:1
#
# The backup image: ghcr.io/yechpa/slax-backup. PostgreSQL 16's client tools (the same 16.15
# as the server image the chart runs), the AWS CLI v2, bash and curl, on the Alpine release
# of that server image, plus the two scripts:
#   pg-backup.sh      daily pg_dump to S3 (CronJob slax-backup)
#   restore-check.sh  weekly restore of the latest dump into a throwaway server (CronJob
#                     slax-restore-check)
# Both read their settings from the environment (see each script) and take AWS credentials
# from the default chain: in production, the EC2 instance role (no key in the image or the
# cluster).
#
# Build from the repository root (files listed in Dockerfile.dockerignore):
#   docker build -f docker/backup/Dockerfile -t slax-backup .
#
# Runs as uid 70 (PostgreSQL's in the server image) on a read-only root filesystem: only /tmp
# is written (HOME=/tmp for the AWS CLI's cache).

# alpine 3.24.3
ARG ALPINE_IMAGE=alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a

FROM ${ALPINE_IMAGE} AS runtime

# Alpine's own packages for this release (postgresql16-client and aws-cli are in community);
# `apk upgrade` takes the security fixes newer than the base image, like slax-app. The client
# must stay on PostgreSQL 16 (the server's major version).
RUN apk upgrade --no-cache \
    && apk add --no-cache postgresql16-client aws-cli bash curl \
    && pg_dump --version | grep -q ' 16\.' \
    && aws --version

COPY --chmod=0755 deploy/backup/pg-backup.sh deploy/backup/restore-check.sh /usr/local/bin/
COPY --chmod=0644 deploy/backup/lib.sh /usr/local/bin/lib.sh

ENV HOME=/tmp \
    AWS_PAGER="" \
    AWS_CLI_AUTO_PROMPT=off
USER 70:70
WORKDIR /tmp
# The CronJobs pass the script to run as the argument.
ENTRYPOINT []
CMD ["pg-backup.sh"]
