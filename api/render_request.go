package main

import (
	"context"
	"encoding/json"
	"io"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

// renderResource is the canonical authenticated render endpoint.  The older
// endpoint-specific request shapes are normalized into this representation so
// all routes share the same storage, quota, analytics, and webhook pipeline.
const renderResource = "/api/v1/render"

const (
	renderKindHTML     = "html"
	renderKindDocument = "document"
	renderKindTemplate = "template"
	renderKindURL      = "url"
	renderKindUpload   = "upload"
)

type canonicalRenderRequest struct {
	Version       string                `json:"version"`
	Source        canonicalRenderSource `json:"source"`
	CSS           string                `json:"css,omitempty"`
	Data          map[string]any        `json:"data,omitempty"`
	Options       documentRenderOptions `json:"options,omitempty"`
	Label         string                `json:"label,omitempty"`
	WebhookURL    string                `json:"webhookUrl,omitempty"`
	WebhookSecret string                `json:"webhookSecret,omitempty"`
}

// canonicalRenderSource intentionally has the union of source fields.  The
// normalizer below rejects fields that do not belong to the selected type.
type canonicalRenderSource struct {
	Type       string         `json:"type"`
	Content    string         `json:"content,omitempty"`
	TemplateID string         `json:"templateId,omitempty"`
	Variables  map[string]any `json:"variables,omitempty"`
	URL        string         `json:"url,omitempty"`
	UploadID   string         `json:"uploadId,omitempty"`
	Entrypoint string         `json:"entrypoint,omitempty"`
	ID         string         `json:"id,omitempty"`
}

type normalizedRenderRequest struct {
	Kind          string
	Body          string
	Canonical     bool
	SourceType    string
	SourceMode    string
	SourceVersion string
	Label         string
}

func isCanonicalRenderRequest(request events.APIGatewayProxyRequest) bool {
	return request.Resource == renderResource || request.Path == renderResource
}

// normalizeRenderRequest is the single boundary between route-specific API
// adapters and the renderer. It does no I/O: template lookup, URL validation,
// package extraction, and document compilation remain in their existing
// specialized stages after a request has been normalized.
func normalizeRenderRequest(ctx context.Context, request events.APIGatewayProxyRequest, ownerID string) (normalizedRenderRequest, error) {
	if isCanonicalRenderRequest(request) {
		return normalizeCanonicalRenderRequestWithOwner(ctx, request.Body, ownerID)
	}
	if isDocumentRenderRequest(request) {
		return normalizedRenderRequest{Kind: renderKindDocument, Body: request.Body}, nil
	}
	if isTemplateRenderRequest(request) {
		return normalizedRenderRequest{Kind: renderKindTemplate, Body: request.Body}, nil
	}
	// The anonymous trial route retains its separate free-form HTML contract.
	// All authenticated source modes enter through /render.
	return normalizedRenderRequest{Kind: renderKindHTML, Body: request.Body}, nil
}

func normalizeCanonicalRenderRequest(body string) (normalizedRenderRequest, error) {
	return normalizeCanonicalRenderRequestWithOwner(context.Background(), body, "")
}
func normalizeCanonicalRenderRequestWithOwner(ctx context.Context, body, ownerID string) (normalizedRenderRequest, error) {
	var request canonicalRenderRequest
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return normalizedRenderRequest{}, &renderError{Code: "render_request_invalid", Message: "Invalid render request", Status: 400}
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return normalizedRenderRequest{}, &renderError{Code: "render_request_invalid", Message: "Invalid render request", Status: 400}
	}
	if request.Version != documentRequestVersion {
		return normalizedRenderRequest{}, &renderError{Code: "render_version_unsupported", Message: "version must be \"1\"", Status: 422}
	}
	if len([]rune(strings.TrimSpace(request.Label))) > 120 {
		return normalizedRenderRequest{}, &renderError{Code: "render_label_invalid", Message: "label must be 120 characters or fewer", Status: 422}
	}

	result := normalizedRenderRequest{Canonical: true, SourceType: request.Source.Type, SourceMode: "inline", SourceVersion: request.Version, Label: strings.TrimSpace(request.Label)}
	marshal := func(value any) (string, error) {
		encoded, err := json.Marshal(value)
		if err != nil {
			return "", &renderError{Code: "render_request_invalid", Message: "Invalid render request", Status: 400}
		}
		return string(encoded), nil
	}
	noDocumentFields := func() bool {
		return request.CSS == "" && request.Data == nil && request.Options == (documentRenderOptions{})
	}

	switch request.Source.Type {
	case "html", "markdown":
		if request.Source.ID != "" || request.Source.TemplateID != "" || request.Source.Variables != nil || request.Source.URL != "" || request.Source.UploadID != "" || request.Source.Entrypoint != "" {
			return normalizedRenderRequest{}, &renderError{Code: "render_source_invalid", Message: "source contains fields not supported by its type", Status: 422}
		}
		document := documentRenderRequest{Version: request.Version, CSS: request.CSS, Data: request.Data, Options: request.Options, Label: result.Label, WebhookURL: request.WebhookURL, WebhookSecret: request.WebhookSecret}
		if request.Source.Type == "html" {
			document.HTML = request.Source.Content
		} else {
			document.Source = &documentRenderSource{Type: "markdown", Content: request.Source.Content}
		}
		encoded, err := marshal(document)
		if err != nil {
			return normalizedRenderRequest{}, err
		}
		result.Kind, result.Body = renderKindDocument, encoded
	case "template":
		if request.Source.ID != "" || request.Source.Content != "" || request.Source.URL != "" || request.Source.UploadID != "" || request.Source.Entrypoint != "" || !noDocumentFields() {
			return normalizedRenderRequest{}, &renderError{Code: "render_source_invalid", Message: "source contains fields not supported by its type", Status: 422}
		}
		encoded, err := marshal(templateRenderRequest{TemplateID: request.Source.TemplateID, Variables: request.Source.Variables, Label: result.Label, WebhookURL: request.WebhookURL, WebhookSecret: request.WebhookSecret})
		if err != nil {
			return normalizedRenderRequest{}, err
		}
		result.Kind, result.Body = renderKindTemplate, encoded
	case "url":
		if request.Source.ID != "" || request.Source.Content != "" || request.Source.TemplateID != "" || request.Source.Variables != nil || request.Source.UploadID != "" || request.Source.Entrypoint != "" || !noDocumentFields() {
			return normalizedRenderRequest{}, &renderError{Code: "render_source_invalid", Message: "source contains fields not supported by its type", Status: 422}
		}
		encoded, err := marshal(URLRequest{URL: request.Source.URL, WebhookURL: request.WebhookURL, WebhookSecret: request.WebhookSecret})
		if err != nil {
			return normalizedRenderRequest{}, err
		}
		result.Kind, result.Body = renderKindURL, encoded
	case "upload":
		if request.Source.ID != "" || request.Source.Content != "" || request.Source.TemplateID != "" || request.Source.Variables != nil || request.Source.URL != "" || !noDocumentFields() {
			return normalizedRenderRequest{}, &renderError{Code: "render_source_invalid", Message: "source contains fields not supported by its type", Status: 422}
		}
		encoded, err := marshal(packageRenderRequest{UploadID: request.Source.UploadID, Entrypoint: request.Source.Entrypoint, WebhookURL: request.WebhookURL, WebhookSecret: request.WebhookSecret})
		if err != nil {
			return normalizedRenderRequest{}, err
		}
		result.Kind, result.Body = renderKindUpload, encoded
	case "stored":
		if request.Source.ID == "" || request.Source.Content != "" || request.Source.TemplateID != "" || request.Source.Variables != nil || request.Source.URL != "" || request.Source.UploadID != "" || request.Source.Entrypoint != "" || request.CSS != "" || request.Options != (documentRenderOptions{}) || ownerID == "" {
			return normalizedRenderRequest{}, &renderError{Code: "render_source_invalid", Message: "stored sources require source.id and may only override data", Status: 422}
		}
		definition, err := sourceDefinitionLoader(ctx, ownerID, request.Source.ID)
		if err != nil {
			return normalizedRenderRequest{}, err
		}
		if request.Data != nil {
			definition.Data = request.Data
		}
		definition.Label = request.Label
		if definition.Label == "" {
			if meta, metaErr := sourceStoreFactory().Get(ctx, ownerID, request.Source.ID); metaErr == nil {
				definition.Label = meta.Name
			}
		}
		definition.WebhookURL, definition.WebhookSecret = request.WebhookURL, request.WebhookSecret
		encoded, _ := json.Marshal(definition)
		result, err := normalizeCanonicalRenderRequestWithOwner(ctx, string(encoded), ownerID)
		if err != nil {
			return normalizedRenderRequest{}, err
		}
		result.SourceType, result.SourceMode = definition.Source.Type, "stored"
		return result, nil
	default:
		return normalizedRenderRequest{}, &renderError{Code: "render_source_type_invalid", Message: "source.type must be html, markdown, template, url, upload, or stored", Status: 422}
	}
	return result, nil
}
