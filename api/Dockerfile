FROM golang:1.25 AS builder

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

FROM alpine:3.22 AS fonts

RUN apk add --no-cache curl && \
    mkdir -p /fonts && \
    curl -f -sSL -o /fonts/Inter.ttf "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf" && \
    curl -f -sSL -o /fonts/Inter-Italic.ttf "https://github.com/google/fonts/raw/main/ofl/inter/Inter-Italic%5Bopsz%2Cwght%5D.ttf" && \
    curl -f -sSL -o /fonts/Roboto.ttf "https://github.com/google/fonts/raw/main/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf" && \
    curl -f -sSL -o /fonts/Roboto-Italic.ttf "https://github.com/google/fonts/raw/main/ofl/roboto/Roboto-Italic%5Bwdth%2Cwght%5D.ttf" && \
    curl -f -sSL -o /fonts/OpenSans.ttf "https://github.com/google/fonts/raw/main/ofl/opensans/OpenSans%5Bwdth%2Cwght%5D.ttf" && \
    curl -f -sSL -o /fonts/OpenSans-Italic.ttf "https://github.com/google/fonts/raw/main/ofl/opensans/OpenSans-Italic%5Bwdth%2Cwght%5D.ttf" && \
    curl -f -sSL -o /fonts/Lato-Regular.ttf "https://github.com/google/fonts/raw/main/ofl/lato/Lato-Regular.ttf" && \
    curl -f -sSL -o /fonts/Lato-Bold.ttf "https://github.com/google/fonts/raw/main/ofl/lato/Lato-Bold.ttf" && \
    curl -f -sSL -o /fonts/Lato-Italic.ttf "https://github.com/google/fonts/raw/main/ofl/lato/Lato-Italic.ttf" && \
    curl -f -sSL -o /fonts/Lato-BoldItalic.ttf "https://github.com/google/fonts/raw/main/ofl/lato/Lato-BoldItalic.ttf" && \
    curl -f -sSL -o /fonts/Montserrat.ttf "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf" && \
    curl -f -sSL -o /fonts/Montserrat-Italic.ttf "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat-Italic%5Bwght%5D.ttf"

FROM public.ecr.aws/lambda/provided:al2023

ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp
ENV XDG_CACHE_HOME=/tmp
ENV TMPDIR=/tmp

COPY --from=chromium /chromium /opt/chromium
COPY --from=fonts /fonts /opt/fonts
COPY --from=fonts /fonts /usr/share/fonts/google
COPY --from=builder /build/bootstrap /var/task/bootstrap

RUN dnf install -y fontconfig && \
    fc-cache -f -v /opt/fonts /usr/share/fonts/google && \
    dnf clean all

ENTRYPOINT ["/var/task/bootstrap"]
