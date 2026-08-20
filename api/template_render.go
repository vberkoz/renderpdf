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
	TemplateID    string         `json:"templateId"`
	Variables     map[string]any `json:"variables"`
	WebhookURL    string         `json:"webhookUrl,omitempty"`
	WebhookSecret string         `json:"webhookSecret,omitempty"`
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
	if request.Variables == nil {
		return "", templateRenderRequest{}, &renderError{Code: missingTemplateVariableCode, Message: "variables is required", Status: 422}
	}
	template, err := store.Get(ctx, ownerID, request.TemplateID)
	if err != nil {
		return "", templateRenderRequest{}, err
	}
	html, err := renderTemplateHTML(template.HTML, request.Variables)
	if err != nil {
		return "", templateRenderRequest{}, err
	}
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
	pdf, err := generate(ctx, rewriteTfoot(ensureColgroup(injectPrintCSS(html))))
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
