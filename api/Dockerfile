FROM golang:1.24 AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o bootstrap main.go

FROM public.ecr.aws/lambda/provided:al2023

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
    wget \
    xdg-utils && \
    curl -Lo "/tmp/chrome.rpm" "https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm" && \
    rpm -ivh /tmp/chrome.rpm && \
    rm /tmp/chrome.rpm

ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp
ENV XDG_CACHE_HOME=/tmp

COPY --from=builder /build/bootstrap /var/task/bootstrap

ENTRYPOINT ["/var/task/bootstrap"]
