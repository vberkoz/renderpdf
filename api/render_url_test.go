package main

import (
	"net"
	"testing"
)

func TestIsPublicIP(t *testing.T) {
	tests := []struct {
		address string
		want    bool
	}{
		{"8.8.8.8", true},
		{"127.0.0.1", false},
		{"10.0.0.1", false},
		{"169.254.169.254", false},
		{"::1", false},
		{"fc00::1", false},
	}

	for _, test := range tests {
		t.Run(test.address, func(t *testing.T) {
			if got := isPublicIP(net.ParseIP(test.address)); got != test.want {
				t.Fatalf("isPublicIP(%s) = %t, want %t", test.address, got, test.want)
			}
		})
	}
}

func TestValidateRenderURLRejectsUnsafeTargetsBeforeDNSLookup(t *testing.T) {
	tests := []string{
		"",
		"ftp://example.com/document",
		"http://localhost/document",
		"http://127.0.0.1/document",
		"http://10.0.0.1/document",
		"https://example.com:8443/document",
		"https://user:password@example.com/document",
	}

	for _, target := range tests {
		t.Run(target, func(t *testing.T) {
			if _, err := validateRenderURL(target); err == nil {
				t.Fatalf("expected %q to be rejected", target)
			}
		})
	}
}

func TestValidateAndScrubURLHeaders(t *testing.T) {
	targetURL := "https://reports.example.com/q4"

	// 1. Valid custom headers
	scrubbed, err := validateAndScrubURLHeaders(targetURL, map[string]string{
		"authorization":  "Bearer secret-token-123",
		"X-Custom-Scope": "tenant-a",
	})
	if err != nil {
		t.Fatalf("expected valid headers to pass, got: %v", err)
	}
	if scrubbed["Authorization"] != "Bearer secret-token-123" || scrubbed["X-Custom-Scope"] != "tenant-a" {
		t.Fatalf("unexpected scrubbed headers: %#v", scrubbed)
	}

	// 2. Disallowed SSRF / hop-by-hop / spoofing headers
	disallowed := []string{
		"Host",
		"host",
		"X-Forwarded-For",
		"X-Forwarded-Host",
		"X-Forwarded-Proto",
		"X-Real-IP",
		"Transfer-Encoding",
		"Content-Length",
		"Connection",
		"Proxy-Authorization",
		"CF-Connecting-IP",
		"True-Client-IP",
		"Forwarded",
		"Via",
		"Sec-Fetch-Site",
	}
	for _, h := range disallowed {
		t.Run("disallowed_"+h, func(t *testing.T) {
			_, err := validateAndScrubURLHeaders(targetURL, map[string]string{h: "spoofed"})
			if err == nil {
				t.Fatalf("expected header %q to be rejected", h)
			}
			rErr, ok := err.(*renderError)
			if !ok || rErr.Status != 422 || rErr.Code != "url_header_disallowed" {
				t.Fatalf("expected 422 url_header_disallowed for %q, got: %#v", h, err)
			}
		})
	}

	// 3. CRLF injection & invalid header tokens
	invalidHeaders := []map[string]string{
		{"X-Injected": "ok\r\nX-Evil: 1"},
		{"X-Null": "bad\x00value"},
		{"Invalid Header Name": "value"},
		{":authority": "internal.local"},
	}
	for i, hdrs := range invalidHeaders {
		_, err := validateAndScrubURLHeaders(targetURL, hdrs)
		if err == nil {
			t.Fatalf("case %d: expected invalid header to be rejected: %#v", i, hdrs)
		}
		rErr, ok := err.(*renderError)
		if !ok || rErr.Status != 422 || rErr.Code != "url_header_invalid" {
			t.Fatalf("case %d: expected 422 url_header_invalid, got: %#v", i, err)
		}
	}

	// 4. Feature flag rollback URL_AUTH_HEADERS_ENABLED=false
	t.Setenv("URL_AUTH_HEADERS_ENABLED", "false")
	_, err = validateAndScrubURLHeaders(targetURL, map[string]string{"Authorization": "Bearer abc"})
	if err == nil {
		t.Fatalf("expected error when URL_AUTH_HEADERS_ENABLED=false")
	}
	if rErr, ok := err.(*renderError); !ok || rErr.Code != "url_headers_disabled" {
		t.Fatalf("expected url_headers_disabled, got: %#v", err)
	}
}

func TestValidateURLCookies(t *testing.T) {
	targetURL := "https://app.example.com/dashboard"

	// 1. Valid cookies (implicit domain, exact domain, parent domain)
	trueVal := true
	cookies, err := validateURLCookies(targetURL, []urlCookie{
		{Name: "session_id", Value: "xyz987", Secure: &trueVal, HTTPOnly: &trueVal, SameSite: "Lax"},
		{Name: "tenant", Value: "acme", Domain: ".example.com", Path: "/dashboard"},
	})
	if err != nil {
		t.Fatalf("expected valid cookies, got: %v", err)
	}
	if len(cookies) != 2 || cookies[0].Domain != "app.example.com" || cookies[1].Domain != "example.com" {
		t.Fatalf("unexpected validated cookies: %#v", cookies)
	}

	// 2. Reject cross-domain, localhost, and private-IP cookie domains
	badDomains := []string{
		"other-domain.com",
		"localhost",
		"127.0.0.1",
		"169.254.169.254",
		"0x7f000001",
		"com",
	}
	for _, dom := range badDomains {
		t.Run("bad_domain_"+dom, func(t *testing.T) {
			_, err := validateURLCookies(targetURL, []urlCookie{
				{Name: "sid", Value: "123", Domain: dom},
			})
			if err == nil {
				t.Fatalf("expected cookie domain %q to be rejected", dom)
			}
			rErr, ok := err.(*renderError)
			if !ok || rErr.Status != 422 || rErr.Code != "url_cookie_domain_invalid" {
				t.Fatalf("expected 422 url_cookie_domain_invalid for %q, got: %#v", dom, err)
			}
		})
	}

	// 3. Reject CRLF / semicolon injection in cookie value or invalid sameSite
	if _, err := validateURLCookies(targetURL, []urlCookie{{Name: "sid", Value: "abc; Path=/admin"}}); err == nil {
		t.Fatalf("expected semicolon in cookie value to be rejected")
	}
	if _, err := validateURLCookies(targetURL, []urlCookie{{Name: "sid", Value: "abc", SameSite: "InvalidMode"}}); err == nil {
		t.Fatalf("expected invalid SameSite to be rejected")
	}
}

func TestIsSameOriginHeaderTarget(t *testing.T) {
	target := "https://app.example.com/reports/q4"

	if !isSameOriginHeaderTarget(target, "https://app.example.com/api/data.json") {
		t.Fatalf("expected same origin path to match")
	}
	if !isSameOriginHeaderTarget(target, "https://APP.EXAMPLE.COM:443/styles.css") {
		t.Fatalf("expected explicit default port 443 and uppercase host to match")
	}
	if isSameOriginHeaderTarget(target, "http://app.example.com/styles.css") {
		t.Fatalf("expected scheme downgrade https -> http to be rejected")
	}
	if isSameOriginHeaderTarget(target, "https://cdn.example.com/app.js") {
		t.Fatalf("expected different subdomain to be rejected")
	}
	if isSameOriginHeaderTarget(target, "https://thirdparty-analytics.com/track.js") {
		t.Fatalf("expected third-party domain to be rejected")
	}
}

