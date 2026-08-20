package main

import (
	"encoding/json"
	"io"
	"strings"
)

// batchRenderRequest is the persistence- and queue-ready request contract for
// the future POST /api/v1/batches endpoint. It deliberately does not enqueue
// work yet; keeping parsing separate lets the API and worker share the exact
// same validation boundary.
type batchRenderRequest struct {
	Version string             `json:"version"`
	Source  *batchSource       `json:"source,omitempty"`
	Items   []batchRenderItem  `json:"items"`
	Options batchRenderOptions `json:"options,omitempty"`
}

type batchSource struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type batchRenderItem struct {
	Data       map[string]any          `json:"data,omitempty"`
	Definition *canonicalRenderRequest `json:"definition,omitempty"`
}

type batchRenderOptions struct {
	WebhookURL    string `json:"webhookUrl,omitempty"`
	WebhookSecret string `json:"webhookSecret,omitempty"`
}

func parseBatchRenderRequest(body string) (batchRenderRequest, error) {
	var request batchRenderRequest
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return request, &renderError{Code: "batch_request_invalid", Message: "Invalid batch request", Status: 400}
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return request, &renderError{Code: "batch_request_invalid", Message: "Invalid batch request", Status: 400}
	}
	if request.Version != documentRequestVersion {
		return request, &renderError{Code: "batch_version_unsupported", Message: "version must be \"1\"", Status: 422}
	}
	if len(request.Items) == 0 || len(request.Items) > maxBatchItemsPerJob {
		return request, &renderError{Code: "batch_item_limit_invalid", Message: "items must contain between 1 and 99 entries", Status: 422}
	}
	if request.Source != nil {
		if request.Source.Type != "stored" || strings.TrimSpace(request.Source.ID) == "" {
			return request, &renderError{Code: "batch_source_invalid", Message: "source must be a stored source with an id", Status: 422}
		}
		for _, item := range request.Items {
			if item.Definition != nil {
				return request, &renderError{Code: "batch_item_mode_conflict", Message: "items must provide data when a shared source is supplied", Status: 422}
			}
		}
		return request, nil
	}
	for _, item := range request.Items {
		if item.Definition == nil || item.Data != nil {
			return request, &renderError{Code: "batch_item_definition_required", Message: "items must provide a complete definition when source is omitted", Status: 422}
		}
		if item.Definition.Version != documentRequestVersion || item.Definition.WebhookURL != "" || item.Definition.WebhookSecret != "" {
			return request, &renderError{Code: "batch_item_definition_invalid", Message: "item definitions must be version 1 and cannot set webhooks", Status: 422}
		}
		switch item.Definition.Source.Type {
		case "html", "markdown", "template", "url", "upload":
		default:
			return request, &renderError{Code: "batch_item_definition_invalid", Message: "item definition source type is not supported", Status: 422}
		}
	}
	return request, nil
}
