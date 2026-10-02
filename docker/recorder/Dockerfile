# The terminal recorder (ORC-029; server/studio/container.ts): VHS 0.12.1 with ttyd, Chromium and ffmpeg, plus Node
# for the planned CLIs' scripts. `npm run recorder:build` builds it; the service never builds or pulls an image.
# When this file changes, bump the tag in package.json (recorder:build) and RECORDER_IMAGE in container.ts together.
#
# Both images are pinned by digest. Nothing is downloaded while building beyond the two images.

FROM node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4 AS node

FROM ghcr.io/charmbracelet/vhs:v0.12.1@sha256:ea49a6a1c529be83153e88321892b5585964418f0b9055e8c1e0d732194234a3

# Node 22 (one binary; it needs only libc and libstdc++, which the VHS image has).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# The ttyd wrapper: the tape's shell starts at the artifact's root.
COPY ttyd /usr/local/bin/ttyd

# The recorder's user. The service runs every container as this user (--user 10001:10001), never as root.
RUN chmod 0555 /usr/local/bin/ttyd /usr/local/bin/node \
 && useradd --uid 10001 --user-group --no-create-home --home-dir /home/recorder --shell /usr/sbin/nologin recorder \
 && node --version

USER 10001:10001
WORKDIR /work
# The service names every command in full; the VHS image's own entrypoint (vhs) does not apply.
ENTRYPOINT []
CMD []
