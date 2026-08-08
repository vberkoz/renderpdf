package main

import (
	"errors"
	"reflect"
	"testing"
)

func TestRenderTemplateHTMLInterpolatesNestedVariables(t *testing.T) {
	html, err := renderTemplateHTML(`<h1>Invoice {{invoice.number}}</h1><p>{{customer.name}}</p>`, map[string]any{
		"invoice":  map[string]any{"number": "INV-1042"},
		"customer": map[string]any{"name": "Ada & Sons"},
	})
	if err != nil {
		t.Fatalf("render template: %v", err)
	}
	if want := `<h1>Invoice INV-1042</h1><p>Ada &amp; Sons</p>`; html != want {
		t.Fatalf("HTML = %q, want %q", html, want)
	}
}

func TestRenderTemplateHTMLRejectsMissingAndUnknownVariables(t *testing.T) {
	tests := []struct {
		name      string
		template  string
		variables map[string]any
		code      string
	}{
		{"missing", `<p>{{customer.name}}</p>`, map[string]any{"customer": map[string]any{}}, missingTemplateVariableCode},
		{"unknown", `<p>{{customer.name}}</p>`, map[string]any{"customer": map[string]any{"name": "Ada", "email": "ada@example.com"}}, unknownTemplateVariableCode},
		{"invalid placeholder", `<p>{{customer-name}}</p>`, map[string]any{}, invalidTemplateVariableCode},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := renderTemplateHTML(test.template, test.variables)
			var renderErr *renderError
			if !errors.As(err, &renderErr) {
				t.Fatalf("error = %v, want renderError", err)
			}
			if renderErr.Status != 422 || renderErr.Code != test.code {
				t.Fatalf("error = %#v, want status 422 and code %q", renderErr, test.code)
			}
		})
	}
}

func TestTemplateVariablePaths(t *testing.T) {
	got := templateVariablePaths(`{{customer.name}} {{invoice.number}} {{customer.name}}`)
	want := []string{"customer.name", "invoice.number"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("paths = %#v, want %#v", got, want)
	}
}
