FROM node:22.16.0-alpine3.22

LABEL maintainer="grc-explorer Project"
LABEL description="Development environment for grc-explorer frontend"

# Two Alpine-specific fixes:
#   1. libc6-compat — Next's prebuilt SWC binary is `@next/swc-linux-x64-gnu`,
#      built against glibc. Alpine ships musl, so it fails to load
#      ld-linux-x86-64.so.2 without the glibc shim.
#   2. HOME / cache env — the dev compose pins `user:` to a host UID that
#      has no /etc/passwd entry, so $HOME defaults to / and `next dev`
#      crashes with EACCES on /.cache and /.npm.
RUN apk add --no-cache libc6-compat

ENV HOME=/tmp
ENV NPM_CONFIG_CACHE=/tmp/.npm
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /usr/src/app

COPY . /usr/src/app
RUN rm -rf ./node_modules

RUN npm install

# Wipe /tmp at the end of build so the non-root runtime UID gets a
# clean cache dir. Anything `npm install` cached into /tmp/.npm or
# /tmp/.cache as root can't be touched (utime/EPERM) by the runtime
# user even with mode 1777 — only ownership permits timestamp bumps.
RUN rm -rf /tmp && mkdir -m 1777 /tmp

EXPOSE 3002

CMD ["npm", "run", "dev"]
