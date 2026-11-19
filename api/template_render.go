package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

const (
	dashboardTemplateRenderResource = "/api/v1/dashboard/render-template"
)

type templateRenderRequest struct {
	TemplateID    string                 `json:"templateId"`
	Variables     map[string]any         `json:"variables"`
	Options       *documentRenderOptions `json:"options,omitempty"`
	Label         string                 `json:"label,omitempty"`
	WebhookURL    string                 `json:"webhookUrl,omitempty"`
	WebhookSecret string                 `json:"webhookSecret,omitempty"`
}

func isTemplateRenderRequest(request events.APIGatewayProxyRequest) bool {
	return request.Resource == dashboardTemplateRenderResource || request.Path == dashboardTemplateRenderResource
}

func resolveTemplateRenderHTML(ctx context.Context, store templateStore, ownerID, body string) (string, templateRenderRequest, error) {
	var request templateRenderRequest
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return "", templateRenderRequest{}, &renderError{Code: "template_render_request_invalid", Message: "Invalid template render request", Status: 400}
	}
	if strings.TrimSpace(request.TemplateID) == "" {
		return "", templateRenderRequest{}, &renderError{Code: "template_id_required", Message: "templateId is required", Status: 422}
	}
	if request.Options != nil {
		if err := validateDocumentOptions(request.Options); err != nil {
			return "", templateRenderRequest{}, err
		}
	}
	template, err := store.Get(ctx, ownerID, request.TemplateID)
	if err != nil {
		if errors.Is(err, errTemplateNotFound) && ownerID != "" {
			def, defErr := sourceDefinitionLoader(ctx, ownerID, request.TemplateID)
			if defErr == nil {
				return resolveStoredSourceAsTemplate(ctx, ownerID, def, request)
			}
			if isStoredSourceNotFound(defErr) || isStoredSourceUnconfigured(defErr) {
				return "", templateRenderRequest{}, errTemplateNotFound
			}
			return "", templateRenderRequest{}, defErr
		}
		return "", templateRenderRequest{}, err
	}
	if strings.TrimSpace(request.Label) == "" {
		request.Label = template.Name
	}
	vars := mergeTemplateVariableMaps(template.Variables, request.Variables)
	if vars == nil {
		vars = map[string]any{}
	}
	allowExtra := false
	if request.Options != nil && (request.Options.AllowExtraVariables != nil || request.Options.StrictVariables != nil) {
		allowExtra = request.Options.allowExtraVariables()
	} else if template.Variables != nil && request.Variables != nil {
		allowExtra = true
	}
	html, err := renderTemplateHTMLWithOptions(template.HTML, vars, allowExtra)
	if err != nil {
		return "", templateRenderRequest{}, err
	}
	return html, request, nil
}

func resolveStoredSourceAsTemplate(ctx context.Context, ownerID string, def canonicalRenderRequest, request templateRenderRequest) (string, templateRenderRequest, error) {
	mergedData := mergeTemplateVariableMaps(def.Data, request.Variables)
	if mergedData == nil {
		mergedData = map[string]any{}
	}
	opts := def.Options
	if request.Options != nil {
		opts = mergeDocumentRenderOptions(def.Options, *request.Options)
	}
	if def.Data != nil && request.Variables != nil && opts.AllowExtraVariables == nil && opts.StrictVariables == nil {
		allow := true
		opts.AllowExtraVariables = &allow
	}
	label := strings.TrimSpace(request.Label)
	if label == "" {
		if meta, metaErr := sourceStoreFactory().Get(ctx, ownerID, request.TemplateID); metaErr == nil {
			label = meta.Name
			request.Label = meta.Name
		}
	}
	docReq := documentRenderRequest{
		Version:       def.Version,
		CSS:           def.CSS,
		Data:          mergedData,
		Options:       opts,
		Label:         label,
		WebhookURL:    request.WebhookURL,
		WebhookSecret: request.WebhookSecret,
	}
	if docReq.Version == "" {
		docReq.Version = documentRequestVersion
	}
	switch def.Source.Type {
	case "html":
		docReq.HTML = def.Source.Content
	case "markdown":
		docReq.Source = &documentRenderSource{Type: "markdown", Content: def.Source.Content}
	default:
		return "", templateRenderRequest{}, &renderError{Code: "stored_source_invalid", Message: "Stored source is invalid", Status: 422}
	}
	encoded, err := json.Marshal(docReq)
	if err != nil {
		return "", templateRenderRequest{}, &renderError{Code: "stored_source_invalid", Message: "Stored source is invalid", Status: 422}
	}
	html, parsedDoc, err := resolveDocumentRenderHTML(string(encoded))
	if err != nil {
		return "", templateRenderRequest{}, err
	}
	request.Options = &parsedDoc.Options
	return html, request, nil
}

// renderTemplatePDF is a narrow seam around the existing PDF pipeline. It
// lets tests assert the final HTML supplied to Chromium without requiring a
// local Chrome installation.
func renderTemplatePDF(ctx context.Context, store templateStore, ownerID, body string, generate func(context.Context, string) ([]byte, error)) ([]byte, error) {
	html, _, err := resolveTemplateRenderHTML(ctx, store, ownerID, body)
	if err != nil {
		return nil, err
	}
	pdf, err := generate(ctx, transformBarcodes(rewriteTfoot(injectPrintCSS(html))))
	if err != nil {
		return nil, fmt.Errorf("generate template PDF: %w", err)
	}
	return pdf, nil
}

func templateRenderErrorResponse(err error, headers map[string]string) events.APIGatewayProxyResponse {
	if errors.Is(err, errTemplateNotFound) {
		return errorResponse(404, "Template not found", headers)
	}
	return renderErrorResponse(err, headers)
}
