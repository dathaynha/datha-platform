# ---- build stage ----
FROM golang:1.25-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /bin/gateway ./cmd/gateway

# ---- runtime stage ----
FROM scratch

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /bin/gateway /gateway

EXPOSE 8080

ENTRYPOINT ["/gateway"]
