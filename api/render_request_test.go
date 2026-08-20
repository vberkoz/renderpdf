package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

func TestCanonicalRenderRequestNormalizesDocumentSources(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantSource string
	}{
		{
			name: "html",
			body: `{"version":"1","source":{"type":"html","content":"<h1>{{title}}</h1>"},"data":{"title":"Ada"},"options":{"format":"A4","margin":"18mm"}}`,
		},
		{
			name:       "markdown",
			body:       `{"version":"1","source":{"type":"markdown","content":"# {{title}}"},"data":{"title":"Ada"},"options":{"format":"A4","margin":"18mm"}}`,
			wantSource: "markdown",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			normalized, err := normalizeRenderRequest(context.Background(), events.APIGatewayProxyRequest{Resource: renderResource, Body: test.body}, "customer-a")
			if err != nil {
				t.Fatalf("normalizeRenderRequest() error = %v", err)
			}
			if normalized.Kind != renderKindDocument || !normalized.Canonical || normalized.SourceType != test.name {
				t.Fatalf("normalized = %#v", normalized)
			}
			var document documentRenderRequest
			if err := json.Unmarshal([]byte(normalized.Body), &document); err != nil {
				t.Fatal(err)
			}
			if document.HTML == "" && document.Source == nil {
				t.Fatal("expected normalized document source")
			}
			if test.wantSource != "" && document.Source.Type != test.wantSource {
				t.Fatalf("source = %#v", document.Source)
			}
		})
	}
}

func TestCanonicalRenderRequestNormalizesSpecializedSources(t *testing.T) {
	tests := []struct {
		name string
		body string
		kind string
	}{
		{"template", `{"version":"1","source":{"type":"template","templateId":"invoice","variables":{"name":"Ada"}}}`, renderKindTemplate},
		{"url", `{"version":"1","source":{"type":"url","url":"https://example.com"}}`, renderKindURL},
		{"upload", `{"version":"1","source":{"type":"upload","uploadId":"0f8fad5b-d9cb-469f-a165-70867728950e","entrypoint":"index.html"}}`, renderKindUpload},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			normalized, err := normalizeRenderRequest(context.Background(), events.APIGatewayProxyRequest{Path: renderResource, Body: test.body}, "customer-a")
			if err != nil || normalized.Kind != test.kind {
				t.Fatalf("normalized = %#v, error = %v", normalized, err)
			}
		})
	}
}

func TestCanonicalRenderRequestRejectsInvalidSourceContract(t *testing.T) {
	tests := []string{
		`{"version":"2","source":{"type":"html","content":"<p>x</p>"}}`,
		`{"version":"1","source":{"type":"html","content":"<p>x</p>","url":"https://example.com"}}`,
		`{"version":"1","source":{"type":"url","url":"https://example.com"},"css":"p{}"}`,
		`{"version":"1","source":{"type":"unknown"}}`,
		`{"version":"1","source":{"type":"html","content":"<p>x</p>","unexpected":true}}`,
	}
	for _, body := range tests {
		if _, err := normalizeRenderRequest(context.Background(), events.APIGatewayProxyRequest{Resource: renderResource, Body: body}, "customer-a"); err == nil {
			t.Fatalf("normalizeRenderRequest(%s) succeeded", body)
		}
	}
}

func TestLegacyRenderRoutesNormalizeToSharedKinds(t *testing.T) {
	tests := []struct{ resource, want string }{
		{dashboardDocumentRenderResource, renderKindDocument},
		{dashboardTemplateRenderResource, renderKindTemplate},
		{renderURLResource, renderKindURL},
		{trialResource, renderKindHTML},
	}
	for _, test := range tests {
		normalized, err := normalizeRenderRequest(context.Background(), events.APIGatewayProxyRequest{Resource: test.resource, Body: `{}`}, "customer-a")
		if err != nil || normalized.Kind != test.want {
			t.Fatalf("resource %s: normalized = %#v, error = %v", test.resource, normalized, err)
		}
	}
}
