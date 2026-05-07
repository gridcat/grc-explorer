FROM node:22.16.0-alpine3.22

LABEL maintainer="grc-explorer Project"
LABEL description="Development environment for grc-explorer backend service"

# When the dev compose pins `user: ${DEV_UID:-0}:${DEV_GID:-0}` to the
# host user, that UID has no entry in /etc/passwd → no $HOME → npm
# tries to write its cache to /.npm and crashes with EACCES. Two fixes:
#   1. NPM_CONFIG_CACHE → a world-writable path
#   2. HOME → same, so any tool that touches $HOME (like ts-node's
#      type cache) works
ENV HOME=/tmp
ENV NPM_CONFIG_CACHE=/tmp/.npm

WORKDIR /usr/src/app

COPY . /usr/src/app
RUN rm -rf ./node_modules

RUN npm install

# `npm install` runs as root at build time. The runtime container runs
# as a non-root host UID (DEV_UID) and `utime()` against root-owned
# files in /tmp fails with EPERM regardless of mode bits — wipe /tmp
# at build end so the runtime user starts clean.
RUN rm -rf /tmp && mkdir -m 1777 /tmp

CMD ["npm", "run", "dev"]
