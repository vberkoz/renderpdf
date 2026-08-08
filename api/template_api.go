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

type templateListResponse struct {
	Templates []Template             `json:"templates"`
	Starters  []starterTemplateReply `json:"starters"`
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
	templateID := templateRequestID(request)

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
		template, err := store.Get(ctx, ownerID, templateID)
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
		existing, err := store.Get(ctx, ownerID, templateID)
		if err != nil {
			return templateStoreErrorResponse(err, headers)
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
	if id := strings.TrimSpace(request.PathParameters["id"]); id != "" {
		return id
	}
	path := request.Path
	if path == "" {
		path = request.Resource
	}
	return strings.TrimPrefix(strings.TrimPrefix(path, templateResource), "/")
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
