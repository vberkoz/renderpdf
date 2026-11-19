package main

import (
	"errors"
	"strings"
	"testing"
)

func TestTransformRedactionTagDefaultBar(t *testing.T) {
	input := `<p>Customer SSN: <redact>123-45-6789</redact></p>`
	output := transformRedaction(input, nil)

	if strings.Contains(output, "123-45-6789") {
		t.Errorf("expected sensitive SSN to be removed from output, got: %s", output)
	}
	if !strings.Contains(output, `class="pdf-redaction-bar"`) {
		t.Errorf("expected pdf-redaction-bar class, got: %s", output)
	}
	if !strings.Contains(output, "████████") {
		t.Errorf("expected black bar block characters, got: %s", output)
	}
}

func TestTransformRedactionTagMasking(t *testing.T) {
	cases := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "mask ssn",
			input:    `<p>SSN: <redact style="mask" type="ssn">123-45-6789</redact></p>`,
			expected: "***-**-6789",
		},
		{
			name:     "mask credit card",
			input:    `<p>Card: <redact style="mask" type="creditCard">4111-2222-3333-4444</redact></p>`,
			expected: "****-****-****-4444",
		},
		{
			name:     "mask email",
			input:    `<p>Email: <redact style="mask" type="email">john.doe@renderpdf.io</redact></p>`,
			expected: "j***@renderpdf.io",
		},
		{
			name:     "mask phone",
			input:    `<p>Phone: <redact style="mask" type="phone">415-555-1234</redact></p>`,
			expected: "(***) ***-1234",
		},
		{
			name:     "replacement text default",
			input:    `<p>Secret: <redact style="text">topsecret</redact></p>`,
			expected: "[REDACTED]",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			output := transformRedaction(tc.input, nil)
			if !strings.Contains(output, tc.expected) {
				t.Errorf("expected output to contain %q, got: %s", tc.expected, output)
			}
		})
	}
}

func TestTransformRedactionDataAttributes(t *testing.T) {
	input := `<div data-redact="true" data-redact-type="email" data-redact-style="mask">contact@renderpdf.io</div>`
	output := transformRedaction(input, nil)

	if strings.Contains(output, "contact@renderpdf.io") {
		t.Errorf("expected original email to be excised, got: %s", output)
	}
	if !strings.Contains(output, "c***@renderpdf.io") {
		t.Errorf("expected masked email, got: %s", output)
	}
}

func TestTransformRedactionOptionsAutomatedScrubbing(t *testing.T) {
	input := `<p>Customer profile: SSN 123-45-6789, CC 4111 2222 3333 4444, user@renderpdf.io, 415-555-1234, token CONFIDENTIAL-98765.</p>`

	opts := &redactionOptions{
		Enabled:  true,
		Types:    []string{"ssn", "creditCard", "email", "phone"},
		Patterns: []string{`CONFIDENTIAL-\d+`},
	}

	output := transformRedaction(input, opts)

	if strings.Contains(output, "123-45-6789") {
		t.Errorf("expected SSN to be scrubbed")
	}
	if strings.Contains(output, "4111 2222 3333 4444") {
		t.Errorf("expected Credit Card to be scrubbed")
	}
	if strings.Contains(output, "user@renderpdf.io") {
		t.Errorf("expected Email to be scrubbed")
	}
	if strings.Contains(output, "415-555-1234") {
		t.Errorf("expected Phone to be scrubbed")
	}
	if strings.Contains(output, "CONFIDENTIAL-98765") {
		t.Errorf("expected Custom pattern to be scrubbed")
	}

	if !strings.Contains(output, `class="pdf-redaction-bar"`) {
		t.Errorf("expected redaction bars to be rendered, got: %s", output)
	}
}

func TestTransformRedactionPreservesScriptAndStyle(t *testing.T) {
	input := `<html><head><style>.ssn-box { color: #123456; }</style><script>var secret = "123-45-6789";</script></head><body><p>SSN: 123-45-6789</p></body></html>`

	opts := &redactionOptions{
		Enabled: true,
		Types:   []string{"ssn"},
	}

	output := transformRedaction(input, opts)

	// Script and style tags must not be altered
	if !strings.Contains(output, `<style>.ssn-box { color: #123456; }</style>`) {
		t.Errorf("expected style tag to be preserved, got: %s", output)
	}
	if !strings.Contains(output, `var secret = "123-45-6789";`) {
		t.Errorf("expected script tag content to be preserved, got: %s", output)
	}
	// Body text SSN must be redacted
	if strings.Contains(output, `<p>SSN: 123-45-6789</p>`) {
		t.Errorf("expected body SSN to be redacted, got: %s", output)
	}
}

func TestValidateDocumentRedactionOptions(t *testing.T) {
	t.Run("invalid replacement", func(t *testing.T) {
		opts := documentRenderOptions{
			Redaction: &redactionOptions{
				Replacement: "invalid_mode",
			},
		}
		err := validateDocumentOptions(&opts)
		var rErr *renderError
		if !errors.As(err, &rErr) || rErr.Code != "document_redaction_replacement_invalid" {
			t.Errorf("expected document_redaction_replacement_invalid, got: %v", err)
		}
	})

	t.Run("unsupported type", func(t *testing.T) {
		opts := documentRenderOptions{
			Redaction: &redactionOptions{
				Types: []string{"passport"},
			},
		}
		err := validateDocumentOptions(&opts)
		var rErr *renderError
		if !errors.As(err, &rErr) || rErr.Code != "document_redaction_type_invalid" {
			t.Errorf("expected document_redaction_type_invalid, got: %v", err)
		}
	})

	t.Run("invalid regex pattern", func(t *testing.T) {
		opts := documentRenderOptions{
			Redaction: &redactionOptions{
				Patterns: []string{"(?i)[a-z"},
			},
		}
		err := validateDocumentOptions(&opts)
		var rErr *renderError
		if !errors.As(err, &rErr) || rErr.Code != "document_redaction_pattern_invalid" {
			t.Errorf("expected document_redaction_pattern_invalid, got: %v", err)
		}
	})
}
