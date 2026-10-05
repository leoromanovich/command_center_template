ARG PYTHON_IMAGE=python:3.12.14-alpine3.23@sha256:d339953547bb5bc57eb5c1ff3224c40890ce56e494b13a52a574658e5a0f888a
FROM ${PYTHON_IMAGE}

ARG RUFF_VERSION=0.16.7
RUN pip install --no-cache-dir "ruff==${RUFF_VERSION}" \
    && addgroup -g 1000 agent && adduser -D -u 1000 -G agent agent \
    && mkdir -p /workspace /build /context /home/agent
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 RUFF_NO_CACHE=true
USER 1000:1000
WORKDIR /workspace
CMD ["sh"]
