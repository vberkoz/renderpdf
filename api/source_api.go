package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/google/uuid"
)

const sourceResource = "/api/v1/sources"
const dashboardSourceResource = "/api/v1/dashboard/sources"
const (
	maxSourcesPerOwner     = 100
	maxSourceStorageBytes  = 25 * 1024 * 1024
	maxBatchItemsPerJob    = 99
	maxConcurrentBatchJobs = 2
	maxPDFRetentionDays    = 30
)

var errSourceNotFound = errors.New("source not found")

type savedSource struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	SourceType string    `json:"sourceType"`
	Version    string    `json:"version"`
	SizeBytes  int64     `json:"sizeBytes"`
	Checksum   string    `json:"checksum"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
	ObjectKey  string    `json:"-"`
	OwnerID    string    `json:"-"`
}

type sourceWriteRequest struct {
	Name       string                 `json:"name"`
	Definition canonicalRenderRequest `json:"definition"`
}

type sourceStore interface {
	Create(context.Context, savedSource) error
	Get(context.Context, string, string) (savedSource, error)
	List(context.Context, string) ([]savedSource, error)
	Update(context.Context, savedSource) error
	Delete(context.Context, string, string) error
}

type sourceDynamoDBAPI interface {
	PutItem(*dynamodb.PutItemInput) (*dynamodb.PutItemOutput, error)
	GetItem(*dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error)
	Query(*dynamodb.QueryInput) (*dynamodb.QueryOutput, error)
	DeleteItem(*dynamodb.DeleteItemInput) (*dynamodb.DeleteItemOutput, error)
}

type dynamoSourceStore struct {
	tableName string
	client    sourceDynamoDBAPI
}

func newDynamoSourceStore(tableName string, client sourceDynamoDBAPI) *dynamoSourceStore {
	return &dynamoSourceStore{tableName, client}
}
func sourceOwnerKey(owner string) string {
	digest := sha256.Sum256([]byte("renderpdf-source-owner:" + owner))
	return "ACCOUNT#" + hex.EncodeToString(digest[:])
}
func sourceItemKey(owner, id string) map[string]*dynamodb.AttributeValue {
	return map[string]*dynamodb.AttributeValue{"PK": {S: aws.String(sourceOwnerKey(owner))}, "SK": {S: aws.String("SOURCE#" + id)}}
}
func (s *dynamoSourceStore) Create(_ context.Context, v savedSource) error {
	_, err := s.client.PutItem(&dynamodb.PutItemInput{TableName: aws.String(s.tableName), Item: sourceItem(v), ConditionExpression: aws.String("attribute_not_exists(PK) AND attribute_not_exists(SK)")})
	return err
}
func (s *dynamoSourceStore) Get(_ context.Context, owner, id string) (savedSource, error) {
	out, err := s.client.GetItem(&dynamodb.GetItemInput{TableName: aws.String(s.tableName), Key: sourceItemKey(owner, id), ConsistentRead: aws.Bool(true)})
	if err != nil {
		return savedSource{}, err
	}
	if out.Item == nil {
		return savedSource{}, errSourceNotFound
	}
	return sourceFromItem(out.Item)
}
func (s *dynamoSourceStore) List(_ context.Context, owner string) ([]savedSource, error) {
	out, err := s.client.Query(&dynamodb.QueryInput{TableName: aws.String(s.tableName), KeyConditionExpression: aws.String("PK = :pk AND begins_with(SK, :prefix)"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":pk": {S: aws.String(sourceOwnerKey(owner))}, ":prefix": {S: aws.String("SOURCE#")}}})
	if err != nil {
		return nil, err
	}
	values := make([]savedSource, 0, len(out.Items))
	for _, item := range out.Items {
		v, e := sourceFromItem(item)
		if e != nil {
			return nil, e
		}
		values = append(values, v)
	}
	return values, nil
}
func (s *dynamoSourceStore) Update(_ context.Context, v savedSource) error {
	_, err := s.client.PutItem(&dynamodb.PutItemInput{TableName: aws.String(s.tableName), Item: sourceItem(v), ConditionExpression: aws.String("attribute_exists(PK) AND attribute_exists(SK)")})
	return err
}
func (s *dynamoSourceStore) Delete(_ context.Context, owner, id string) error {
	_, err := s.client.DeleteItem(&dynamodb.DeleteItemInput{TableName: aws.String(s.tableName), Key: sourceItemKey(owner, id), ConditionExpression: aws.String("attribute_exists(PK)")})
	return err
}
func sourceItem(v savedSource) map[string]*dynamodb.AttributeValue {
	item := sourceItemKey(v.OwnerID, v.ID)
	item["entityType"] = &dynamodb.AttributeValue{S: aws.String("SOURCE")}
	item["id"] = &dynamodb.AttributeValue{S: aws.String(v.ID)}
	item["name"] = &dynamodb.AttributeValue{S: aws.String(v.Name)}
	item["sourceType"] = &dynamodb.AttributeValue{S: aws.String(v.SourceType)}
	item["version"] = &dynamodb.AttributeValue{S: aws.String(v.Version)}
	item["sizeBytes"] = &dynamodb.AttributeValue{N: aws.String(fmt.Sprint(v.SizeBytes))}
	item["checksum"] = &dynamodb.AttributeValue{S: aws.String(v.Checksum)}
	item["objectKey"] = &dynamodb.AttributeValue{S: aws.String(v.ObjectKey)}
	item["createdAt"] = &dynamodb.AttributeValue{S: aws.String(v.CreatedAt.Format(time.RFC3339Nano))}
	item["updatedAt"] = &dynamodb.AttributeValue{S: aws.String(v.UpdatedAt.Format(time.RFC3339Nano))}
	return item
}
func sourceFromItem(item map[string]*dynamodb.AttributeValue) (savedSource, error) {
	get := func(n string) string {
		if a := item[n]; a != nil && a.S != nil {
			return *a.S
		}
		return ""
	}
	size := int64(0)
	if a := item["sizeBytes"]; a != nil && a.N != nil {
		fmt.Sscan(*a.N, &size)
	}
	c, e := time.Parse(time.RFC3339Nano, get("createdAt"))
	if e != nil {
		return savedSource{}, e
	}
	u, e := time.Parse(time.RFC3339Nano, get("updatedAt"))
	if e != nil {
		return savedSource{}, e
	}
	return savedSource{ID: get("id"), Name: get("name"), SourceType: get("sourceType"), Version: get("version"), SizeBytes: size, Checksum: get("checksum"), ObjectKey: get("objectKey"), CreatedAt: c, UpdatedAt: u}, nil
}

var sourceStoreFactory = func() sourceStore {
	return newDynamoSourceStore(os.Getenv("DOCUMENT_STORE_TABLE_NAME"), dynamodb.New(sess))
}
var sourceDefinitionLoader = func(ctx context.Context, ownerID, sourceID string) (canonicalRenderRequest, error) {
	meta, err := sourceStoreFactory().Get(ctx, ownerID, sourceID)
	if err != nil {
		if errors.Is(err, errSourceNotFound) {
			return canonicalRenderRequest{}, &renderError{Code: "stored_source_not_found", Message: "Stored source not found", Status: 404}
		}
		return canonicalRenderRequest{}, &renderError{Code: "stored_source_unavailable", Message: "Stored source is temporarily unavailable", Status: 503}
	}
	object, err := s3Client.GetObjectWithContext(ctx, &s3.GetObjectInput{Bucket: aws.String(bucketName), Key: aws.String(meta.ObjectKey)})
	if err != nil {
		return canonicalRenderRequest{}, &renderError{Code: "stored_source_unavailable", Message: "Stored source is temporarily unavailable", Status: 503}
	}
	defer object.Body.Close()
	body, err := io.ReadAll(io.LimitReader(object.Body, maxDocumentRequestBytes+1))
	if err != nil || len(body) > maxDocumentRequestBytes {
		return canonicalRenderRequest{}, &renderError{Code: "stored_source_invalid", Message: "Stored source is invalid", Status: 422}
	}
	var definition canonicalRenderRequest
	if err = json.Unmarshal(body, &definition); err != nil {
		return canonicalRenderRequest{}, &renderError{Code: "stored_source_invalid", Message: "Stored source is invalid", Status: 422}
	}
	if definition.Version != documentRequestVersion || (definition.Source.Type != "html" && definition.Source.Type != "markdown") || definition.WebhookURL != "" || definition.WebhookSecret != "" {
		return canonicalRenderRequest{}, &renderError{Code: "stored_source_invalid", Message: "Stored source is invalid", Status: 422}
	}
	return definition, nil
}

func isSourceRequest(r events.APIGatewayProxyRequest) bool {
	return r.Path == sourceResource || r.Resource == sourceResource || strings.HasPrefix(r.Path, sourceResource+"/") || strings.HasPrefix(r.Resource, sourceResource+"/") || r.Path == dashboardSourceResource || strings.HasPrefix(r.Path, dashboardSourceResource+"/")
}
func sourceID(r events.APIGatewayProxyRequest) string {
	p := r.Path
	if p == "" {
		p = r.Resource
	}
	if strings.HasPrefix(p, dashboardSourceResource) {
		return strings.TrimPrefix(strings.TrimPrefix(p, dashboardSourceResource), "/")
	}
	return strings.TrimPrefix(strings.TrimPrefix(p, sourceResource), "/")
}
func handleSourceRequest(ctx context.Context, r events.APIGatewayProxyRequest, h map[string]string, store sourceStore) events.APIGatewayProxyResponse {
	owner, id := authorizerValue(r, "userId"), sourceID(r)
	if owner == "" {
		return errorResponse(http.StatusUnauthorized, "Authentication is required", h)
	}
	if r.HTTPMethod == http.MethodGet {
		if id == "" {
			values, err := store.List(ctx, owner)
			if err != nil {
				return sourceError(err, h)
			}
			return sourceJSON(http.StatusOK, map[string]any{"sources": values}, h)
		}
		value, err := store.Get(ctx, owner, id)
		if err != nil {
			return sourceError(err, h)
		}
		return sourceJSON(http.StatusOK, value, h)
	}
	if r.HTTPMethod == http.MethodDelete {
		if id == "" {
			return errorResponse(http.StatusMethodNotAllowed, "Source id is required", h)
		}
		value, err := store.Get(ctx, owner, id)
		if err != nil {
			return sourceError(err, h)
		}
		if err = store.Delete(ctx, owner, id); err != nil {
			return sourceError(err, h)
		}
		if err = deletePrivateObject(bucketName, value.ObjectKey); err != nil {
			fmt.Printf("source object delete failed: %v\n", err)
		}
		return events.APIGatewayProxyResponse{StatusCode: http.StatusNoContent, Headers: h}
	}
	if r.HTTPMethod != http.MethodPost && r.HTTPMethod != http.MethodPut {
		return errorResponse(http.StatusMethodNotAllowed, "Method not allowed", h)
	}
	if (r.HTTPMethod == http.MethodPost && id != "") || (r.HTTPMethod == http.MethodPut && id == "") {
		return errorResponse(http.StatusMethodNotAllowed, "Source id is required", h)
	}
	input, err := decodeSourceWrite(r.Body)
	if err != nil {
		return renderErrorResponse(err, h)
	}
	definition, err := validSourceDefinition(input.Definition)
	if err != nil {
		return renderErrorResponse(err, h)
	}
	if id == "" {
		id = "src_" + uuid.NewString()
	}
	now := time.Now().UTC()
	createdAt := now
	previousSize := int64(0)
	if r.HTTPMethod == http.MethodPut {
		old, err := store.Get(ctx, owner, id)
		if err != nil {
			return sourceError(err, h)
		}
		createdAt = old.CreatedAt
		previousSize = old.SizeBytes
	}
	encoded, _ := json.Marshal(definition)
	existing, listErr := store.List(ctx, owner)
	if listErr != nil {
		return sourceError(listErr, h)
	}
	if r.HTTPMethod == http.MethodPost {
		if len(existing) >= maxSourcesPerOwner {
			return errorResponseWithCode(http.StatusConflict, "source_limit_reached", "Saved source limit reached", h)
		}
	}
	var used int64
	for _, source := range existing {
		used += source.SizeBytes
	}
	if used-previousSize+int64(len(encoded)) > maxSourceStorageBytes {
		return errorResponseWithCode(http.StatusConflict, "source_storage_limit_reached", "Saved source storage limit reached", h)
	}
	sum := sha256.Sum256(encoded)
	value := savedSource{ID: id, Name: input.Name, SourceType: definition.Source.Type, Version: definition.Version, SizeBytes: int64(len(encoded)), Checksum: "sha256:" + hex.EncodeToString(sum[:]), ObjectKey: sourceDefinitionObjectKey(owner, id), OwnerID: owner, CreatedAt: createdAt, UpdatedAt: now}
	if _, err = storeSourceDefinition(owner, id, encoded); err != nil {
		return errorResponse(503, "Source storage is temporarily unavailable", h)
	}
	if r.HTTPMethod == http.MethodPost {
		err = store.Create(ctx, value)
	} else {
		err = store.Update(ctx, value)
	}
	if err != nil {
		return sourceError(err, h)
	}
	status := http.StatusOK
	if r.HTTPMethod == http.MethodPost {
		status = http.StatusCreated
	}
	return sourceJSON(status, value, h)
}
func decodeSourceWrite(body string) (sourceWriteRequest, error) {
	var v sourceWriteRequest
	d := json.NewDecoder(strings.NewReader(body))
	d.DisallowUnknownFields()
	if e := d.Decode(&v); e != nil {
		return v, &renderError{Code: "source_request_invalid", Message: "Invalid source request", Status: 400}
	}
	if e := d.Decode(&struct{}{}); e != io.EOF {
		return v, &renderError{Code: "source_request_invalid", Message: "Invalid source request", Status: 400}
	}
	if strings.TrimSpace(v.Name) == "" {
		return v, &renderError{Code: "source_name_required", Message: "name is required", Status: 422}
	}
	return v, nil
}
func validSourceDefinition(v canonicalRenderRequest) (canonicalRenderRequest, error) {
	if v.WebhookURL != "" || v.WebhookSecret != "" || (v.Source.Type != "html" && v.Source.Type != "markdown") {
		return v, &renderError{Code: "source_definition_invalid", Message: "Sources must contain an HTML or Markdown definition without webhook settings", Status: 422}
	}
	if _, e := normalizeCanonicalRenderRequest(mustJSON(v)); e != nil {
		return v, e
	}
	return v, nil
}
func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
func sourceError(e error, h map[string]string) events.APIGatewayProxyResponse {
	if errors.Is(e, errSourceNotFound) {
		return errorResponse(404, "Source not found", h)
	}
	return errorResponse(503, "Source storage is temporarily unavailable", h)
}
func sourceJSON(status int, v any, h map[string]string) events.APIGatewayProxyResponse {
	b, _ := json.Marshal(v)
	return events.APIGatewayProxyResponse{StatusCode: status, Body: string(b), Headers: h}
}
