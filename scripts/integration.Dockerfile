# The integration suite's Linux runner: Node, the libraries VS Code needs, and Xvfb.
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates xauth xvfb \
    libasound2 libgbm1 libgtk-3-0 libnss3 libsecret-1-0 libxkbfile1 libxss1 \
  && rm -rf /var/lib/apt/lists/*
