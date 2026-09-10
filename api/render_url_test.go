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
