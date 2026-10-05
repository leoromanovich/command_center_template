# Structure only; not built by the lightweight example.
# Pin your approved base digest and package/dependency versions for real use.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build python3 python-is-python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home agent \
    && mkdir -p /workspace /build /context /opt/deps
# COPY prebuilt/<toolchain-and-abi>/ /opt/deps/
# Build stable dependencies here, recording their exact revisions.
USER 1000:1000
ENV HOME=/home/agent
WORKDIR /workspace
CMD ["sh"]
