FROM golang:1.24 AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o bootstrap .

FROM public.ecr.aws/lambda/provided:al2023

ARG CHROME_VERSION=150.0.7871.186

RUN dnf install -y \
    at-spi2-atk \
    atk \
    cairo \
    cups-libs \
    dbus-glib \
    dbus-glib-devel \
    gtk3 \
    libXcomposite \
    libXdamage \
    libXrandr \
    libXScrnSaver \
    libXt \
    libXtst \
    nss \
    pango \
    alsa-lib \
    mesa-libgbm \
    libxkbcommon \
    libdrm \
    libXfixes \
    ca-certificates \
    tar \
    gzip \
    liberation-fonts \
    vulkan-loader \
    unzip \
    xdg-utils && \
    curl -Lo "/tmp/chrome-headless-shell.zip" "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-headless-shell-linux64.zip" && \
    unzip -q /tmp/chrome-headless-shell.zip -d /opt && \
    rm /tmp/chrome-headless-shell.zip && \
    chmod -R 755 /opt/chrome-headless-shell-linux64

ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp
ENV XDG_CACHE_HOME=/tmp
ENV TMPDIR=/tmp

RUN mkdir -p /tmp/chrome-data && chmod 777 /tmp/chrome-data

COPY --from=builder /build/bootstrap /var/task/bootstrap

ENTRYPOINT ["/var/task/bootstrap"]
