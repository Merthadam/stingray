# Disposable Linux test environment for Stingray (Electron under Xvfb).
# Built by scripts/test-env.sh — do not build directly from a dirty checkout.
FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb socat zsh git lsof procps curl ca-certificates \
      python3 make g++ \
      libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 libxss1 \
      libxshmfence1 libdrm2 libx11-xcb1 libsecret-1-0 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -s /bin/zsh node \
    && { [ -e /usr/sbin/lsof ] || ln -s /usr/bin/lsof /usr/sbin/lsof; } \
    && { [ -e /bin/ps ] || ln -s /usr/bin/ps /bin/ps; }

WORKDIR /app
RUN chown node:node /app
USER node

# Dependency layer is cached until package-lock.json changes.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY --chown=node:node . .
RUN npm run build

ENV STINGRAY_DATA_DIR=/tmp/stingray-data \
    ELECTRON_DISABLE_SANDBOX=1 \
    SHELL=/bin/zsh
EXPOSE 9223
ENTRYPOINT ["/app/.test-env/entrypoint.sh"]
