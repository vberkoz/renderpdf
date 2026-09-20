package main

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"
)

func TestBlockedIPs(t *testing.T) {
	tests := []struct {
		ip      string
		blocked bool
	}{
		// Public IPv4
		{"8.8.8.8", false},
		{"1.1.1.1", false},
		{"93.184.216.34", false},
		// Public IPv6
		{"2606:4700:4700::1111", false},

		// Loopback IPv4 & IPv6
		{"127.0.0.1", true},
		{"127.0.0.2", true},
		{"127.255.255.255", true},
		{"::1", true},

		// Unspecified
		{"0.0.0.0", true},
		{"::", true},

		// AWS Metadata / Link-local
		{"169.254.169.254", true},
		{"169.254.0.1", true},
		{"169.254.254.254", true},
		{"fe80::1", true},

		// RFC 1918 Private ranges
		{"10.0.0.1", true},
		{"10.255.255.255", true},
		{"172.16.0.1", true},
		{"172.31.255.255", true},
		{"192.168.0.1", true},
		{"192.168.255.255", true},

		// Carrier-Grade NAT (RFC 6598)
		{"100.64.0.1", true},
		{"100.127.255.255", true},

		// Benchmark / Documentation
		{"198.18.0.1", true},
		{"192.0.2.1", true},
		{"198.51.100.1", true},
		{"203.0.113.1", true},

		// Multicast & Reserved
		{"224.0.0.1", true},
		{"240.0.0.1", true},
		{"255.255.255.255", true},
		{"fc00::1", true},
		{"fd12:3456:789a:1::1", true},
		{"ff02::1", true},
	}

	for _, tc := range tests {
		t.Run(tc.ip, func(t *testing.T) {
			parsed := net.ParseIP(tc.ip)
			if parsed == nil {
				t.Fatalf("failed to parse test IP: %s", tc.ip)
			}
			got := isBlockedIP(parsed)
			if got != tc.blocked {
				t.Errorf("isBlockedIP(%s) = %v, want %v", tc.ip, got, tc.blocked)
			}
		})
	}
}

func TestParseAlternativeIP(t *testing.T) {
	tests := []struct {
		host string
		want string
	}{
		{"2130706433", "127.0.0.1"},
		{"0x7f000001", "127.0.0.1"},
		{"0177.0.0.1", "127.0.0.1"},
		{"127.0.0.1", "127.0.0.1"},
		{"example.com", ""},
		{"localhost", ""},
	}

	for _, tc := range tests {
		t.Run(tc.host, func(t *testing.T) {
			got := parseAlternativeIP(tc.host)
			if tc.want == "" {
				if got != nil {
					t.Errorf("parseAlternativeIP(%s) = %v, want nil", tc.host, got)
				}
			} else {
				if got == nil || got.String() != tc.want {
					t.Errorf("parseAlternativeIP(%s) = %v, want %s", tc.host, got, tc.want)
				}
			}
		})
	}
}

func TestNetworkSecurityFilter_Schemes(t *testing.T) {
	filter := newNetworkSecurityFilter(func(ctx context.Context, host string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("93.184.216.34")}, nil
	})

	tests := []struct {
		url  string
		want bool
	}{
		// Data, blob, about URIs
		{"data:text/html;charset=utf-8,<h1>Safe</h1>", true},
		{"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==", true},
		{"blob:http://example.com/00000000-0000-0000-0000-000000000000", true},
		{"about:blank", true},

		// Allowed local package assets
		{"file:///tmp/renderpdf-package-123e4567-e89b-12d3-a456-426614174000/index.html", true},
		{"file:///tmp/renderpdf-package-123e4567-e89b-12d3-a456-426614174000/assets/logo.png", true},

		// Disallowed file paths
		{"file:///etc/passwd", false},
		{"file:///proc/self/environ", false},
		{"file:///var/task/main", false},
		{"file:///tmp/chromium", false},
		{"file:///tmp/chrome-data/Cookies", false},
		{"file:///tmp/renderpdf-package-123/../../etc/passwd", false},

		// Unsupported schemes
		{"ftp://example.com/file", false},
		{"gopher://127.0.0.1:9001/", false},
		{"javascript:alert(1)", false},
		{"", false},
	}

	for _, tc := range tests {
		t.Run(tc.url, func(t *testing.T) {
			got := filter.isAllowedURL(tc.url)
			if got != tc.want {
				t.Errorf("isAllowedURL(%q) = %v, want %v", tc.url, got, tc.want)
			}
		})
	}
}

func TestNetworkSecurityFilter_LambdaAndInternalTargets(t *testing.T) {
	filter := newNetworkSecurityFilter(nil)

	blockedTargets := []string{
		// AWS Lambda Runtime API
		"http://127.0.0.1:9001/2018-06-01/runtime/invocation/next",
		"http://127.0.0.1:9001",
		"http://localhost:9001/2018-06-01/runtime/invocation/next",
		"http://test.localhost:9001",
		"http://printer.local/status",

		// IPv6 loopback
		"http://[::1]:9001/2018-06-01/runtime/invocation/next",
		"http://[::1]/",

		// Unspecified
		"http://0.0.0.0:9001",

		// Cloud metadata / Link-local
		"http://169.254.169.254/latest/meta-data",
		"http://169.254.0.1/secrets",
		"http://[fe80::1]/",

		// Private networks
		"http://10.0.0.1/admin",
		"http://172.16.0.1/",
		"http://192.168.1.1/router",
		"http://100.64.0.1/",

		// Encoded IP representations targeting loopback
		"http://2130706433:9001/2018-06-01/runtime/invocation/next",
		"http://0x7f000001:9001/2018-06-01/runtime/invocation/next",
		"http://0177.0.0.1:9001/2018-06-01/runtime/invocation/next",
	}

	for _, target := range blockedTargets {
		t.Run(target, func(t *testing.T) {
			if filter.isAllowedURL(target) {
				t.Errorf("expected target %q to be blocked, but it was allowed", target)
			}
		})
	}
}

func TestNetworkSecurityFilter_DNSRebinding(t *testing.T) {
	mockResolver := func(ctx context.Context, host string) ([]net.IP, error) {
		switch host {
		case "legit-cdn.com":
			return []net.IP{net.ParseIP("93.184.216.34")}, nil
		case "rebind-to-lambda.com":
			return []net.IP{net.ParseIP("127.0.0.1")}, nil
		case "dual-homed-attack.com":
			return []net.IP{net.ParseIP("93.184.216.34"), net.ParseIP("10.0.0.1")}, nil
		case "nonexistent-domain.xyz":
			return nil, errors.New("nxdomain")
		default:
			return nil, errors.New("unknown host")
		}
	}

	filter := newNetworkSecurityFilter(mockResolver)

	// Public legitimate CDN is allowed
	if !filter.isAllowedURL("https://legit-cdn.com/assets/app.js") {
		t.Errorf("expected legit-cdn.com to be allowed")
	}

	// Domain that resolves to 127.0.0.1 is blocked
	if filter.isAllowedURL("http://rebind-to-lambda.com:9001/2018-06-01/runtime/invocation/next") {
		t.Errorf("expected rebind-to-lambda.com to be blocked")
	}

	// Dual-homed domain containing a private IP is blocked
	if filter.isAllowedURL("https://dual-homed-attack.com/exploit") {
		t.Errorf("expected dual-homed-attack.com to be blocked")
	}

	// Non-resolvable domain fails closed
	if filter.isAllowedURL("https://nonexistent-domain.xyz/font.woff2") {
		t.Errorf("expected nonexistent-domain.xyz to be blocked (fail-closed)")
	}
}

func TestNetworkSecurityFilter_DNSCaching(t *testing.T) {
	var lookupCount int64
	mockResolver := func(ctx context.Context, host string) ([]net.IP, error) {
		atomic.AddInt64(&lookupCount, 1)
		return []net.IP{net.ParseIP("93.184.216.34")}, nil
	}

	filter := newNetworkSecurityFilter(mockResolver)

	// Fetch 5 assets from the same domain
	for i := 0; i < 5; i++ {
		if !filter.isAllowedURL("https://cdn.example.com/image.png") {
			t.Fatalf("expected cdn.example.com to be allowed")
		}
	}

	// Resolver should only have been called once thanks to DNS cache
	if got := atomic.LoadInt64(&lookupCount); got != 1 {
		t.Errorf("lookupCount = %d, want 1 (cached)", got)
	}
}
