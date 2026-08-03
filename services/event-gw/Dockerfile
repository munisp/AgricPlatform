# event-gw — AgricPlatform webhook/event ingestion edge.
# Go standard library only; the build needs no module downloads.
FROM golang:1.22-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal

RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/event-gw ./cmd/event-gw

# Dead-letter spool directory writable by the distroless nonroot user
# (uid/gid 65532). Seed it in the build stage so COPY preserves ownership;
# a named volume mounted over it inherits these permissions on first use.
RUN mkdir -p /spool/event-gw && chown -R 65532:65532 /spool

FROM gcr.io/distroless/static-debian12

COPY --from=build /out/event-gw /event-gw
COPY --from=build /spool /var/spool

ENV EVENTGW_ADDR=:8090 \
    EVENTGW_SPOOL_PATH=/var/spool/event-gw/deadletter.jsonl

USER nonroot
EXPOSE 8090

ENTRYPOINT ["/event-gw"]
