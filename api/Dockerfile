FROM golang:1.24 AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o bootstrap .

FROM alpine:3.22 AS chromium

ARG CHROMIUM_VERSION=149.0.0
RUN apk add --no-cache curl unzip && \
    mkdir -p /chromium && \
    curl -L -o /tmp/chromium-layer.zip \
      "https://github.com/Sparticuz/chromium/releases/download/v${CHROMIUM_VERSION}/chromium-v${CHROMIUM_VERSION}-layer.x64.zip" && \
    unzip -j /tmp/chromium-layer.zip \
      'nodejs/node_modules/@sparticuz/chromium/bin/*' -d /chromium

FROM public.ecr.aws/lambda/provided:al2023

ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp
ENV XDG_CACHE_HOME=/tmp
ENV TMPDIR=/tmp

COPY --from=chromium /chromium /opt/chromium
COPY --from=builder /build/bootstrap /var/task/bootstrap

ENTRYPOINT ["/var/task/bootstrap"]
