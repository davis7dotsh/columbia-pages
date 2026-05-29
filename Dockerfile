# ---- build ----
FROM golang:1.25-alpine AS build
WORKDIR /src

# Cache modules first.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# CGO disabled: modernc.org/sqlite is pure Go, so this builds a static binary.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# ---- runtime ----
FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
WORKDIR /app
COPY --from=build /out/server /app/server

# SQLite database lives on a mounted volume.
ENV PORT=8080 \
    DB_PATH=/data/columbia-pages.db
RUN mkdir -p /data && chown app:app /data
VOLUME ["/data"]
USER app

EXPOSE 8080
CMD ["/app/server"]
