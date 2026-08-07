package main

import "testing"

func TestValidateWebhookURL(t *testing.T) {
	valid, err := validateWebhookURL("https://8.8.8.8/hooks/pdf")
	if err != nil || valid != "https://8.8.8.8/hooks/pdf" {
		t.Fatalf("expected public HTTPS URL to be valid, got %q, %v", valid, err)
	}

	for _, raw := range []string{
		"http://example.com/hook",
		"https://localhost/hook",
		"https://127.0.0.1/hook",
		"https://169.254.169.254/latest/meta-data",
		"https://user:password@example.com/hook",
		"https://example.com:8443/hook",
	} {
		if _, err := validateWebhookURL(raw); err == nil {
			t.Errorf("expected %q to be rejected", raw)
		}
	}
}
