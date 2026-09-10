package main

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

func validateRenderURL(rawURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed == nil || parsed.Host == "" {
		return "", fmt.Errorf("url must be a valid absolute HTTP(S) URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("url must use http or https")
	}
	if parsed.User != nil {
		return "", fmt.Errorf("url must not contain credentials")
	}
	if port := parsed.Port(); port != "" && port != "80" && port != "443" {
		return "", fmt.Errorf("url must use port 80 or 443")
	}

	host := parsed.Hostname()
	if host == "" || strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return "", fmt.Errorf("url must target a public host")
	}

	addresses := []net.IP{net.ParseIP(host)}
	if addresses[0] == nil {
		addresses, err = net.LookupIP(host)
		if err != nil || len(addresses) == 0 {
			return "", fmt.Errorf("url host could not be resolved")
		}
	}
	for _, address := range addresses {
		if !isPublicIP(address) {
			return "", fmt.Errorf("url must target a public host")
		}
	}

	return parsed.String(), nil
}

func isPublicIP(address net.IP) bool {
	if address == nil || address.IsLoopback() || address.IsUnspecified() || address.IsMulticast() || address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() {
		return false
	}
	if ipv4 := address.To4(); ipv4 != nil {
		return !ipv4.IsPrivate() && !ipv4.IsLinkLocalUnicast() && !ipv4.Equal(net.ParseIP("169.254.169.254"))
	}
	return !address.IsPrivate()
}
