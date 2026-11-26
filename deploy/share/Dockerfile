# PancakeSlicer + "Shared folder" (fork build).
# Rebuilds only the Go service and the web UI from this checkout and layers them
# over an unmodified upstream release image, so the qualified engine stays untouched.
#
#   docker build -f deploy/share/Dockerfile \
#     --build-arg BASE=zimengxiong/pancakeslicer:0.5.6 \
#     --build-arg REVISION=$(git rev-parse HEAD) \
#     -t pancakeslicer-share:0.5.6 .
#
# Run with the folder mounted and ORCA_WEB_SHARE_DIR pointing at it, e.g.
#   -v /mnt/nas/3d:/share -e ORCA_WEB_SHARE_DIR=/share
ARG BASE=zimengxiong/pancakeslicer:0.5.6

FROM ${BASE} AS base

FROM golang:1.27.2 AS server
WORKDIR /src/server
COPY server/ ./
ARG REVISION=unknown
RUN CGO_ENABLED=0 go build -trimpath -mod=vendor \
      -ldflags "-s -w -X main.buildRevision=${REVISION}" \
      -o /out/orca-webapp-server .

FROM node:26-bookworm AS web
WORKDIR /src
COPY web/package.json web/package-lock.json web/
RUN npm ci --prefix web --no-audit --no-fund
COPY . .
RUN npm run build --prefix web
COPY --from=base /app/web/ /base-web/
ARG REVISION=unknown
RUN set -eu; \
    cp -a web/dist /out-web; cd /out-web; \
    find . \( -name '*.map' -o -name '*.d.ts' -o -name 'bundle-report.json' \) -delete; \
    find profiles -type f \( -iname '*.png' -o -iname '*.stl' \) -delete; \
    for f in COMPONENTS.json licence.txt third-party-licences.txt; do cp /base-web/$f .; done; \
    echo "${REVISION}" > REVISION.txt; \
    chmod -R a+rX,go-w .

FROM ${BASE}
ARG REVISION=unknown
COPY --from=server /out/orca-webapp-server /app/engine/orca-webapp-server
COPY --from=web /out-web/ /app/web-share/
ENV ORCA_WEB_STATIC=/app/web-share \
    ORCA_WEB_SOURCE_ARCHIVE= \
    ORCA_BUILD_SOURCE_SHA256= \
    ORCA_WEB_SOURCE_URL=https://github.com/SteffOps/PancakeSlicer/tree/{revision} \
    ORCA_BUILD_IMAGE=pancakeslicer-share
LABEL org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.url="https://github.com/SteffOps/PancakeSlicer"
