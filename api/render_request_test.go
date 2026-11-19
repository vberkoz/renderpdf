package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
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

func TestSpecializedRenderRoutesNormalizeToSharedKinds(t *testing.T) {
	tests := []struct{ resource, want string }{
		{dashboardDocumentRenderResource, renderKindDocument},
		{dashboardTemplateRenderResource, renderKindTemplate},
		{trialResource, renderKindHTML},
	}
	for _, test := range tests {
		normalized, err := normalizeRenderRequest(context.Background(), events.APIGatewayProxyRequest{Resource: test.resource, Body: `{}`}, "customer-a")
		if err != nil || normalized.Kind != test.want {
			t.Fatalf("resource %s: normalized = %#v, error = %v", test.resource, normalized, err)
		}
	}
}

type noopTestFileStore struct{}

func (noopTestFileStore) Create(context.Context, storedFile) error          { return nil }
func (noopTestFileStore) Get(context.Context, string, string) (storedFile, error) {
	return storedFile{}, nil
}
func (noopTestFileStore) List(context.Context, string) ([]storedFile, error) { return nil, nil }
func (noopTestFileStore) Delete(context.Context, string, string) error       { return nil }

func TestCanonicalRenderRequestPreservesOptionsAcrossAllSixSources(t *testing.T) {
	trueVal := true
	falseVal := false

	prevLoader := sourceDefinitionLoader
	t.Cleanup(func() { sourceDefinitionLoader = prevLoader })
	sourceDefinitionLoader = func(_ context.Context, ownerID, sourceID string) (canonicalRenderRequest, error) {
		if ownerID != "customer-a" || sourceID != "src-123" {
			t.Fatalf("unexpected sourceDefinitionLoader args: %q, %q", ownerID, sourceID)
		}
		return canonicalRenderRequest{
			Version: "1",
			Source:  canonicalRenderSource{Type: "html", Content: "<p>{{name}}</p>"},
			Data:    map[string]any{"name": "Saved"},
			Options: documentRenderOptions{
				Format:         "A4",
				Margin:         "18mm",
				Landscape:      &falseVal,
				HeaderTemplate: "<div>Saved Header</div>",
			},
		}, nil
	}

	optsJSON := `"options":{"format":"Letter","margin":"12mm","landscape":true,"displayHeaderFooter":true}`
	cases := []struct {
		name       string
		body       string
		wantKind   string
		wantSource string
		wantMode   string
		check      func(t *testing.T, normalized normalizedRenderRequest)
	}{
		{
			name:       "html",
			body:       `{"version":"1","source":{"type":"html","content":"<h1>Hi</h1>"},` + optsJSON + `}`,
			wantKind:   renderKindHTML,
			wantSource: "html",
			wantMode:   "inline",
			check: func(t *testing.T, n normalizedRenderRequest) {
				var req Request
				if err := json.Unmarshal([]byte(n.Body), &req); err != nil {
					t.Fatal(err)
				}
				if req.Options == nil || req.Options.Format != "Letter" || req.Options.Margin != "12mm" || !req.Options.isLandscape() || req.Options.DisplayHeaderFooter == nil || !*req.Options.DisplayHeaderFooter {
					t.Fatalf("html options lost: %#v", req.Options)
				}
			},
		},
		{
			name:       "markdown",
			body:       `{"version":"1","source":{"type":"markdown","content":"# Hi"},` + optsJSON + `}`,
			wantKind:   renderKindDocument,
			wantSource: "markdown",
			wantMode:   "inline",
			check: func(t *testing.T, n normalizedRenderRequest) {
				var req documentRenderRequest
				if err := json.Unmarshal([]byte(n.Body), &req); err != nil {
					t.Fatal(err)
				}
				if req.Options.Format != "Letter" || req.Options.Margin != "12mm" || !req.Options.isLandscape() || req.Options.DisplayHeaderFooter == nil || !*req.Options.DisplayHeaderFooter {
					t.Fatalf("markdown options lost: %#v", req.Options)
				}
			},
		},
		{
			name:       "template",
			body:       `{"version":"1","source":{"type":"template","templateId":"tpl-1","variables":{"name":"Ada"}},` + optsJSON + `}`,
			wantKind:   renderKindTemplate,
			wantSource: "template",
			wantMode:   "inline",
			check: func(t *testing.T, n normalizedRenderRequest) {
				var req templateRenderRequest
				if err := json.Unmarshal([]byte(n.Body), &req); err != nil {
					t.Fatal(err)
				}
				if req.Options == nil || req.Options.Format != "Letter" || req.Options.Margin != "12mm" || !req.Options.isLandscape() || req.Options.DisplayHeaderFooter == nil || !*req.Options.DisplayHeaderFooter {
					t.Fatalf("template options lost: %#v", req.Options)
				}
			},
		},
		{
			name:       "url",
			body:       `{"version":"1","source":{"type":"url","url":"https://example.com"},` + optsJSON + `}`,
			wantKind:   renderKindURL,
			wantSource: "url",
			wantMode:   "inline",
			check: func(t *testing.T, n normalizedRenderRequest) {
				var req URLRequest
				if err := json.Unmarshal([]byte(n.Body), &req); err != nil {
					t.Fatal(err)
				}
				if req.Options == nil || req.Options.Format != "Letter" || req.Options.Margin != "12mm" || !req.Options.isLandscape() || req.Options.DisplayHeaderFooter == nil || !*req.Options.DisplayHeaderFooter {
					t.Fatalf("url options lost: %#v", req.Options)
				}
			},
		},
		{
			name:       "upload",
			body:       `{"version":"1","source":{"type":"upload","uploadId":"0f8fad5b-d9cb-469f-a165-70867728950e","entrypoint":"index.html"},` + optsJSON + `}`,
			wantKind:   renderKindUpload,
			wantSource: "upload",
			wantMode:   "inline",
			check: func(t *testing.T, n normalizedRenderRequest) {
				var req packageRenderRequest
				if err := json.Unmarshal([]byte(n.Body), &req); err != nil {
					t.Fatal(err)
				}
				if req.Options == nil || req.Options.Format != "Letter" || req.Options.Margin != "12mm" || !req.Options.isLandscape() || req.Options.DisplayHeaderFooter == nil || !*req.Options.DisplayHeaderFooter {
					t.Fatalf("upload options lost: %#v", req.Options)
				}
			},
		},
		{
			name:       "stored",
			body:       `{"version":"1","source":{"type":"stored","id":"src-123"},"label":"Monthly Invoice",` + optsJSON + `}`,
			wantKind:   renderKindDocument,
			wantSource: "html",
			wantMode:   "stored",
			check: func(t *testing.T, n normalizedRenderRequest) {
				var req documentRenderRequest
				if err := json.Unmarshal([]byte(n.Body), &req); err != nil {
					t.Fatal(err)
				}
				if req.Options.Format != "Letter" || req.Options.Margin != "12mm" || !req.Options.isLandscape() || req.Options.DisplayHeaderFooter == nil || !*req.Options.DisplayHeaderFooter {
					t.Fatalf("stored merged options incorrect: %#v", req.Options)
				}
				if req.Options.HeaderTemplate != "<div>Saved Header</div>" {
					t.Fatalf("stored base HeaderTemplate lost: %q", req.Options.HeaderTemplate)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			normalized, err := normalizeRenderRequest(context.Background(), events.APIGatewayProxyRequest{
				Resource: renderResource,
				Body:     tc.body,
			}, "customer-a")
			if err != nil {
				t.Fatalf("normalizeRenderRequest(%s) err = %v", tc.name, err)
			}
			if normalized.Kind != tc.wantKind || normalized.SourceType != tc.wantSource || normalized.SourceMode != tc.wantMode {
				t.Fatalf("normalized = %#v, want kind=%q source=%q mode=%q", normalized, tc.wantKind, tc.wantSource, tc.wantMode)
			}
			tc.check(t, normalized)
		})
	}

	// Verify template still rejects css/data and stored still rejects css (even with options present)
	invalidBodies := []string{
		`{"version":"1","source":{"type":"template","templateId":"tpl-1","variables":{"a":"b"}},"css":"body{}","options":{"format":"Letter"}}`,
		`{"version":"1","source":{"type":"template","templateId":"tpl-1","variables":{"a":"b"}},"data":{"a":"b"},"options":{"format":"Letter"}}`,
		`{"version":"1","source":{"type":"stored","id":"src-123"},"css":"body{}","options":{"format":"Letter"}}`,
	}
	for _, bad := range invalidBodies {
		_, err := normalizeRenderRequest(context.Background(), events.APIGatewayProxyRequest{
			Resource: renderResource,
			Body:     bad,
		}, "customer-a")
		var rErr *renderError
		if !errors.As(err, &rErr) || rErr.Code != "render_source_invalid" {
			t.Fatalf("expected render_source_invalid for %s, got %#v", bad, err)
		}
	}
	_ = trueVal
}

func TestTemplateRenderOptionsValidationAndHandlerPropagation(t *testing.T) {
	store := &memoryTemplateAPIStore{
		templates: map[string]Template{
			"customer-a/tpl-1": {
				ID:      "tpl-1",
				Name:    "Invoice",
				Type:    TemplateType("invoice"),
				HTML:    "<h1>{{title}}</h1>",
				OwnerID: "customer-a",
			},
		},
	}

	// 1. resolveTemplateRenderHTML rejects invalid options with 422
	invalidCases := []struct {
		name string
		body string
		code string
	}{
		{"invalid format", `{"templateId":"tpl-1","variables":{"title":"Hi"},"options":{"format":"Tabloid"}}`, "document_format_invalid"},
		{"invalid margin", `{"templateId":"tpl-1","variables":{"title":"Hi"},"options":{"margin":"99mm"}}`, "document_margin_invalid"},
	}
	for _, tc := range invalidCases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := resolveTemplateRenderHTML(context.Background(), store, "customer-a", tc.body)
			var rErr *renderError
			if !errors.As(err, &rErr) || rErr.Status != 422 || rErr.Code != tc.code {
				t.Fatalf("err = %#v, want 422/%s", err, tc.code)
			}
		})
	}

	// 2. handler propagates template options into renderHTMLPDF
	prevClient, prevTable, prevBucket := ddbClient, tableName, bucketName
	prevTemplateFactory, prevFileFactory := templateStoreFactory, fileStoreFactory
	prevRender, prevPut, prevSign := renderHTMLPDF, putRenderedPDFObject, signRenderedPDFDownload
	t.Cleanup(func() {
		ddbClient, tableName, bucketName = prevClient, prevTable, prevBucket
		templateStoreFactory, fileStoreFactory = prevTemplateFactory, prevFileFactory
		renderHTMLPDF, putRenderedPDFObject, signRenderedPDFDownload = prevRender, prevPut, prevSign
	})

	t.Setenv("FREE_MONTHLY_QUOTA", "25")
	tableName = "renderpdf-usage"
	bucketName = "renderpdf-pdfs"
	ddbClient = &fakeDynamoDB{}
	templateStoreFactory = func() templateStore { return store }
	fileStoreFactory = func() fileStore { return noopTestFileStore{} }

	var capturedHTML string
	var capturedOpts documentRenderOptions
	renderHTMLPDF = func(_ context.Context, html string, opts documentRenderOptions) ([]byte, error) {
		capturedHTML = html
		capturedOpts = opts
		return []byte("%PDF-1.4\n%%EOF\n"), nil
	}
	putRenderedPDFObject = func(string, string, []byte) error { return nil }
	signRenderedPDFDownload = func(bucket, key string) (string, error) {
		return "https://signed.example.com/" + bucket + "/" + key, nil
	}

	req := events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Resource:   renderResource,
		Path:       renderResource,
		Body:       `{"version":"1","source":{"type":"template","templateId":"tpl-1","variables":{"title":"Q4"}},"options":{"format":"Letter","margin":"12mm","landscape":true,"displayHeaderFooter":false}}`,
	}
	req.RequestContext.Authorizer = map[string]interface{}{"userId": "customer-a"}

	resp, err := handler(context.Background(), req)
	if err != nil {
		t.Fatalf("handler err = %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200; body=%s", resp.StatusCode, resp.Body)
	}
	if !strings.Contains(capturedHTML, "<h1>Q4</h1>") {
		t.Fatalf("unexpected rendered HTML: %s", capturedHTML)
	}
	if capturedOpts.Format != "Letter" || capturedOpts.Margin != "12mm" || !capturedOpts.isLandscape() || capturedOpts.DisplayHeaderFooter == nil || *capturedOpts.DisplayHeaderFooter != false {
		t.Fatalf("capturedOpts = %#v, want Letter/12mm/landscape=true/displayHeaderFooter=false", capturedOpts)
	}
}
