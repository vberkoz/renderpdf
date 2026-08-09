package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/google/uuid"
)

const templateResource = "/api/v1/templates"

type templateWriteRequest struct {
	Name string       `json:"name"`
	Type TemplateType `json:"type"`
	HTML string       `json:"html"`
}

type templateShareWriteRequest struct {
	RecipientID string            `json:"recipientId"`
	Role        TemplateShareRole `json:"role"`
}

type templateListResponse struct {
	Templates []Template             `json:"templates"`
	Starters  []starterTemplateReply `json:"starters"`
}

type sharedTemplateListResponse struct {
	Templates []SharedTemplate `json:"templates"`
}

type starterTemplateReply struct {
	Name      string                    `json:"name"`
	Type      TemplateType              `json:"type"`
	HTML      string                    `json:"html"`
	Variables []StarterTemplateVariable `json:"variables"`
}

var templateStoreFactory = func() templateStore {
	return newDynamoTemplateStore(os.Getenv("TEMPLATE_TABLE_NAME"), dynamodb.New(sess))
}

func isTemplateRequest(request events.APIGatewayProxyRequest) bool {
	path := request.Path
	if path == "" {
		path = request.Resource
	}
	return path == templateResource || strings.HasPrefix(path, templateResource+"/")
}

func handleTemplateRequest(ctx context.Context, request events.APIGatewayProxyRequest, headers map[string]string, store templateStore) events.APIGatewayProxyResponse {
	ownerID := authorizerValue(request, "userId")
	if ownerID == "" {
		return errorResponse(http.StatusUnauthorized, "Authentication is required", headers)
	}
	segments := templateRequestSegments(request)
	if len(segments) > 0 && segments[0] == "shared" {
		if request.HTTPMethod != http.MethodGet || len(segments) != 1 {
			return errorResponse(http.StatusNotFound, "Not found", headers)
		}
		shares, ok := store.(templateShareStore)
		if !ok {
			return errorResponse(http.StatusServiceUnavailable, "Template sharing is temporarily unavailable", headers)
		}
		templates, err := shares.ListShared(ctx, ownerID)
		if err != nil {
			return templateStoreErrorResponse(err, headers)
		}
		return templateJSONResponse(http.StatusOK, sharedTemplateListResponse{Templates: templates}, headers)
	}
	if len(segments) >= 2 && segments[1] == "shares" {
		return handleTemplateShareRequest(ctx, request, headers, store, ownerID, segments)
	}
	if len(segments) >= 2 && segments[1] == "public-links" {
		return handlePublicTemplateLinkRequest(ctx, request, headers, store, ownerID, segments)
	}
	if len(segments) == 2 && segments[1] == "clone" {
		return handleTemplateCloneRequest(ctx, request, headers, store, ownerID, segments[0])
	}
	if len(segments) > 1 {
		return errorResponse(http.StatusNotFound, "Not found", headers)
	}
	templateID := ""
	if len(segments) == 1 {
		templateID = segments[0]
	}

	switch request.HTTPMethod {
	case http.MethodPost:
		if templateID != "" {
			return errorResponse(http.StatusNotFound, "Not found", headers)
		}
		input, response := decodeTemplateWriteRequest(request.Body, headers)
		if response != nil {
			return *response
		}
		now := time.Now().UTC()
		template := Template{ID: uuid.NewString(), Name: input.Name, Type: input.Type, HTML: input.HTML, OwnerID: ownerID, CreatedAt: now, UpdatedAt: now, Version: 1}
		if err := store.Create(ctx, template); err != nil {
			fmt.Printf("template create failed for owner %s: %v\n", templateOwnerPartition(ownerID), err)
			return templateStoreErrorResponse(err, headers)
		}
		return templateJSONResponse(http.StatusCreated, template, headers)

	case http.MethodGet:
		if templateID == "" {
			templates, err := store.List(ctx, ownerID)
			if err != nil {
				fmt.Printf("template list failed for owner %s: %v\n", templateOwnerPartition(ownerID), err)
				return templateStoreErrorResponse(err, headers)
			}
			return templateJSONResponse(http.StatusOK, templateListResponse{Templates: templates, Starters: starterTemplateReplies()}, headers)
		}
		template, _, err := getAccessibleTemplate(ctx, store, ownerID, templateID)
		if err != nil {
			fmt.Printf("template get failed for owner %s: %v\n", templateOwnerPartition(ownerID), err)
			return templateStoreErrorResponse(err, headers)
		}
		return templateJSONResponse(http.StatusOK, template, headers)

	case http.MethodPut:
		if templateID == "" {
			return errorResponse(http.StatusMethodNotAllowed, "Template id is required", headers)
		}
		input, response := decodeTemplateWriteRequest(request.Body, headers)
		if response != nil {
			return *response
		}
		existing, role, err := getAccessibleTemplate(ctx, store, ownerID, templateID)
		if err != nil {
			return templateStoreErrorResponse(err, headers)
		}
		if role != TemplateShareRoleOwner && role != TemplateShareRoleEditor {
			return errorResponse(http.StatusNotFound, "Template not found", headers)
		}
		existing.Name, existing.Type, existing.HTML = input.Name, input.Type, input.HTML
		existing.UpdatedAt, existing.Version = time.Now().UTC(), existing.Version+1
		if err := store.Update(ctx, existing); err != nil {
			fmt.Printf("template update failed for owner %s: %v\n", templateOwnerPartition(ownerID), err)
			return templateStoreErrorResponse(err, headers)
		}
		return templateJSONResponse(http.StatusOK, existing, headers)

	case http.MethodDelete:
		if templateID == "" {
			return errorResponse(http.StatusMethodNotAllowed, "Template id is required", headers)
		}
		if err := store.Delete(ctx, ownerID, templateID); err != nil {
			fmt.Printf("template delete failed for owner %s: %v\n", templateOwnerPartition(ownerID), err)
			return templateStoreErrorResponse(err, headers)
		}
		return events.APIGatewayProxyResponse{StatusCode: http.StatusNoContent, Headers: headers}
	default:
		return errorResponse(http.StatusMethodNotAllowed, "Method not allowed", headers)
	}
}

func starterTemplateReplies() []starterTemplateReply {
	starters := starterTemplates()
	replies := make([]starterTemplateReply, 0, len(starters))
	for _, starter := range starters {
		replies = append(replies, starterTemplateReply{Name: starter.Name, Type: starter.Type, HTML: starter.HTML, Variables: starter.Variables})
	}
	return replies
}

func templateRequestID(request events.APIGatewayProxyRequest) string {
	segments := templateRequestSegments(request)
	if len(segments) == 1 {
		return segments[0]
	}
	return ""
}

func templateRequestSegments(request events.APIGatewayProxyRequest) []string {
	path := request.Path
	if path == "" {
		path = request.Resource
	}
	remainder := strings.Trim(strings.TrimPrefix(path, templateResource), "/")
	if remainder == "" {
		return nil
	}
	return strings.Split(remainder, "/")
}

func handleTemplateShareRequest(ctx context.Context, request events.APIGatewayProxyRequest, headers map[string]string, store templateStore, ownerID string, segments []string) events.APIGatewayProxyResponse {
	if len(segments) < 2 || len(segments) > 3 {
		return errorResponse(http.StatusNotFound, "Not found", headers)
	}
	shares, ok := store.(templateShareStore)
	if !ok {
		return errorResponse(http.StatusServiceUnavailable, "Template sharing is temporarily unavailable", headers)
	}
	templateID := segments[0]
	if _, err := store.Get(ctx, ownerID, templateID); err != nil {
		return templateStoreErrorResponse(err, headers)
	}
	switch request.HTTPMethod {
	case http.MethodGet:
		if len(segments) != 2 {
			return errorResponse(http.StatusNotFound, "Not found", headers)
		}
		result, err := shares.ListShares(ctx, ownerID, templateID)
		if err != nil {
			return templateStoreErrorResponse(err, headers)
		}
		return templateJSONResponse(http.StatusOK, map[string]any{"shares": result}, headers)
	case http.MethodPost:
		if len(segments) != 2 {
			return errorResponse(http.StatusNotFound, "Not found", headers)
		}
		input, response := decodeTemplateShareWriteRequest(request.Body, headers)
		if response != nil {
			return *response
		}
		now := time.Now().UTC()
		share := TemplateShare{TemplateID: templateID, OwnerID: ownerID, RecipientID: input.RecipientID, Role: input.Role, CreatedAt: now, UpdatedAt: now}
		if err := shares.CreateShare(ctx, share); err != nil {
			return templateStoreErrorResponse(err, headers)
		}
		return templateJSONResponse(http.StatusCreated, share, headers)
	case http.MethodPut:
		if len(segments) != 3 {
			return errorResponse(http.StatusNotFound, "Not found", headers)
		}
		input, response := decodeTemplateShareWriteRequest(request.Body, headers)
		if response != nil {
			return *response
		}
		if input.RecipientID != "" && input.RecipientID != segments[2] {
			return errorResponse(http.StatusBadRequest, "recipientId must match the path", headers)
		}
		share := TemplateShare{TemplateID: templateID, OwnerID: ownerID, RecipientID: segments[2], Role: input.Role, UpdatedAt: time.Now().UTC()}
		if err := shares.UpdateShare(ctx, share); err != nil {
			return templateStoreErrorResponse(err, headers)
		}
		return templateJSONResponse(http.StatusOK, share, headers)
	case http.MethodDelete:
		if len(segments) != 3 {
			return errorResponse(http.StatusNotFound, "Not found", headers)
		}
		if err := shares.DeleteShare(ctx, ownerID, templateID, segments[2]); err != nil {
			return templateStoreErrorResponse(err, headers)
		}
		return events.APIGatewayProxyResponse{StatusCode: http.StatusNoContent, Headers: headers}
	default:
		return errorResponse(http.StatusMethodNotAllowed, "Method not allowed", headers)
	}
}

func handleTemplateCloneRequest(ctx context.Context, request events.APIGatewayProxyRequest, headers map[string]string, store templateStore, recipientID, templateID string) events.APIGatewayProxyResponse {
	if request.HTTPMethod != http.MethodPost {
		return errorResponse(http.StatusMethodNotAllowed, "Method not allowed", headers)
	}
	template, _, err := getAccessibleTemplate(ctx, store, recipientID, templateID)
	if err != nil {
		return templateStoreErrorResponse(err, headers)
	}
	now := time.Now().UTC()
	clone := Template{ID: uuid.NewString(), Name: "Copy of " + template.Name, Type: template.Type, HTML: template.HTML, OwnerID: recipientID, CreatedAt: now, UpdatedAt: now, Version: 1}
	if err := store.Create(ctx, clone); err != nil {
		return templateStoreErrorResponse(err, headers)
	}
	return templateJSONResponse(http.StatusCreated, clone, headers)
}

func handlePublicTemplateLinkRequest(ctx context.Context, request events.APIGatewayProxyRequest, headers map[string]string, store templateStore, ownerID string, segments []string) events.APIGatewayProxyResponse {
	if len(segments) < 2 || len(segments) > 3 {
		return errorResponse(http.StatusNotFound, "Not found", headers)
	}
	public, ok := store.(publicTemplateStore)
	if !ok {
		return errorResponse(http.StatusServiceUnavailable, "Public template links are temporarily unavailable", headers)
	}
	templateID := segments[0]
	if _, err := store.Get(ctx, ownerID, templateID); err != nil {
		return templateStoreErrorResponse(err, headers)
	}
	switch request.HTTPMethod {
	case http.MethodPost:
		if len(segments) != 2 {
			return errorResponse(http.StatusNotFound, "Not found", headers)
		}
		link, err := public.CreatePublicLink(ctx, PublicTemplateLink{TemplateID: templateID, OwnerID: ownerID, CreatedAt: time.Now().UTC()})
		if err != nil {
			return templateStoreErrorResponse(err, headers)
		}
		return templateJSONResponse(http.StatusCreated, link, headers)
	case http.MethodGet:
		if len(segments) != 2 {
			return errorResponse(http.StatusNotFound, "Not found", headers)
		}
		links, err := public.ListPublicLinks(ctx, ownerID, templateID)
		if err != nil {
			return templateStoreErrorResponse(err, headers)
		}
		return templateJSONResponse(http.StatusOK, map[string]any{"links": links}, headers)
	case http.MethodDelete:
		if len(segments) != 3 {
			return errorResponse(http.StatusNotFound, "Not found", headers)
		}
		if err := public.DeletePublicLink(ctx, ownerID, templateID, segments[2]); err != nil {
			return templateStoreErrorResponse(err, headers)
		}
		return events.APIGatewayProxyResponse{StatusCode: http.StatusNoContent, Headers: headers}
	default:
		return errorResponse(http.StatusMethodNotAllowed, "Method not allowed", headers)
	}
}

func decodeTemplateShareWriteRequest(body string, headers map[string]string) (templateShareWriteRequest, *events.APIGatewayProxyResponse) {
	var input templateShareWriteRequest
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		response := errorResponse(http.StatusBadRequest, "Invalid template share request", headers)
		return input, &response
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		response := errorResponse(http.StatusBadRequest, "Invalid template share request", headers)
		return input, &response
	}
	return input, nil
}

func decodeTemplateWriteRequest(body string, headers map[string]string) (templateWriteRequest, *events.APIGatewayProxyResponse) {
	var input templateWriteRequest
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		response := errorResponse(http.StatusBadRequest, "Invalid template request", headers)
		return templateWriteRequest{}, &response
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		response := errorResponse(http.StatusBadRequest, "Invalid template request", headers)
		return templateWriteRequest{}, &response
	}
	return input, nil
}

func templateStoreErrorResponse(err error, headers map[string]string) events.APIGatewayProxyResponse {
	if errors.Is(err, errTemplateNotFound) {
		return errorResponse(http.StatusNotFound, "Template not found", headers)
	}
	if errors.Is(err, errTemplateLimitReached) {
		return errorResponse(http.StatusConflict, "Template limit reached", headers)
	}
	if errors.Is(err, errTemplateShareExists) {
		return errorResponse(http.StatusConflict, "Template is already shared with this recipient", headers)
	}
	if errors.Is(err, errTemplateShareLimit) {
		return errorResponse(http.StatusConflict, "Template share limit reached", headers)
	}
	if errors.Is(err, errTemplateShareNotFound) {
		return errorResponse(http.StatusNotFound, "Template share not found", headers)
	}
	if errors.Is(err, errPublicTemplateLinkNotFound) {
		return errorResponse(http.StatusNotFound, "Public template link not found", headers)
	}
	var validationError *renderError
	if errors.As(err, &validationError) {
		return renderErrorResponse(validationError, headers)
	}
	return errorResponse(http.StatusServiceUnavailable, "Template storage is temporarily unavailable", headers)
}

func templateJSONResponse(status int, value any, headers map[string]string) events.APIGatewayProxyResponse {
	body, _ := json.Marshal(value)
	return events.APIGatewayProxyResponse{StatusCode: status, Body: string(body), Headers: headers}
}
