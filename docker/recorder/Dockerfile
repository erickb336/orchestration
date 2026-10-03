# The recorder (ORC-029; server/studio/container.ts): VHS 0.12.1 with ttyd, Chromium and ffmpeg, plus Node 22 for the
# planned CLIs' scripts, and, for the capture of evidence (pass 5, server/studio/evidence.ts), npm (the install and the
# preview command) and playwright-core (the screenshots, with the image's Chromium). `npm run recorder:build` builds
# it; the service never builds or pulls an image. When this file changes, bump the tag in package.json
# (recorder:build) and RECORDER_IMAGE in container.ts together.
#
# Both images are pinned by digest, and playwright-core by its lockfile's hash (capture/package-lock.json). Nothing
# else is downloaded while building.

FROM node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4 AS node

# playwright-core alone (a library; it downloads no browser), installed with its install scripts off.
FROM node AS capture
WORKDIR /opt/orchestrator
COPY capture/package.json capture/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && node -e "require('/opt/orchestrator/node_modules/playwright-core')"

FROM ghcr.io/charmbracelet/vhs:v0.12.1@sha256:ea49a6a1c529be83153e88321892b5585964418f0b9055e8c1e0d732194234a3

# Node 22 (one binary; it needs only libc and libstdc++, which the VHS image has) and the npm that ships with it.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=capture /opt/orchestrator/node_modules /opt/orchestrator/node_modules
# The ttyd wrapper: the tape's shell starts at the artifact's root.
COPY ttyd /usr/local/bin/ttyd

# The recorder's user. The service runs every container as this user (--user 10001:10001), never as root.
RUN chmod 0555 /usr/local/bin/ttyd /usr/local/bin/node \
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && useradd --uid 10001 --user-group --no-create-home --home-dir /home/recorder --shell /usr/sbin/nologin recorder \
 && node --version && npm --version && test -x /usr/bin/chromium

USER 10001:10001
WORKDIR /work
# The service names every command in full; the VHS image's own entrypoint (vhs) does not apply.
ENTRYPOINT []
CMD []
