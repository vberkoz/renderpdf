package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/service/dynamodb"
)

const fileResource = "/api/v1/files"
const dashboardFileResource = "/api/v1/dashboard/files"
const maxPrivateFileStorageBytes int64 = 500 * 1024 * 1024

var errFileNotFound = errors.New("file not found")

type storedFile struct {
	ID                 string            `json:"id"`
	Kind               string            `json:"kind"`
	ContentType        string            `json:"contentType"`
	SizeBytes          int64             `json:"sizeBytes"`
	Checksum           string            `json:"checksum,omitempty"`
	RetentionExpiresAt *time.Time        `json:"retentionExpiresAt,omitempty"`
	Origin             map[string]string `json:"origin,omitempty"`
	CreatedAt          time.Time         `json:"createdAt"`
	OwnerID            string            `json:"-"`
	Bucket             string            `json:"-"`
	ObjectKey          string            `json:"-"`
}
type fileStore interface {
	Create(context.Context, storedFile) error
	Get(context.Context, string, string) (storedFile, error)
	List(context.Context, string) ([]storedFile, error)
	Delete(context.Context, string, string) error
}
type fileDynamoDBAPI interface {
	PutItem(*dynamodb.PutItemInput) (*dynamodb.PutItemOutput, error)
	GetItem(*dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error)
	Query(*dynamodb.QueryInput) (*dynamodb.QueryOutput, error)
	DeleteItem(*dynamodb.DeleteItemInput) (*dynamodb.DeleteItemOutput, error)
}
type dynamoFileStore struct {
	table  string
	client fileDynamoDBAPI
}

func newDynamoFileStore(table string, client fileDynamoDBAPI) *dynamoFileStore {
	return &dynamoFileStore{table, client}
}
func fileItemKey(owner, id string) map[string]*dynamodb.AttributeValue {
	return map[string]*dynamodb.AttributeValue{"PK": {S: aws.String(sourceOwnerKey(owner))}, "SK": {S: aws.String("FILE#" + id)}}
}
func fileItem(v storedFile) map[string]*dynamodb.AttributeValue {
	item := fileItemKey(v.OwnerID, v.ID)
	item["entityType"] = &dynamodb.AttributeValue{S: aws.String("FILE")}
	item["id"] = &dynamodb.AttributeValue{S: aws.String(v.ID)}
	item["kind"] = &dynamodb.AttributeValue{S: aws.String(v.Kind)}
	item["contentType"] = &dynamodb.AttributeValue{S: aws.String(v.ContentType)}
	item["sizeBytes"] = &dynamodb.AttributeValue{N: aws.String(fmt.Sprint(v.SizeBytes))}
	item["checksum"] = &dynamodb.AttributeValue{S: aws.String(v.Checksum)}
	item["bucket"] = &dynamodb.AttributeValue{S: aws.String(v.Bucket)}
	item["objectKey"] = &dynamodb.AttributeValue{S: aws.String(v.ObjectKey)}
	item["createdAt"] = &dynamodb.AttributeValue{S: aws.String(v.CreatedAt.Format(time.RFC3339Nano))}
	if v.RetentionExpiresAt != nil {
		item["retentionExpiresAt"] = &dynamodb.AttributeValue{S: aws.String(v.RetentionExpiresAt.Format(time.RFC3339Nano))}
	}
	if v.Origin != nil {
		b, _ := json.Marshal(v.Origin)
		item["origin"] = &dynamodb.AttributeValue{S: aws.String(string(b))}
	}
	return item
}
func (f *dynamoFileStore) Create(_ context.Context, v storedFile) error {
	_, e := f.client.PutItem(&dynamodb.PutItemInput{TableName: aws.String(f.table), Item: fileItem(v), ConditionExpression: aws.String("attribute_not_exists(PK) AND attribute_not_exists(SK)")})
	return e
}
func (f *dynamoFileStore) Get(_ context.Context, o, id string) (storedFile, error) {
	out, e := f.client.GetItem(&dynamodb.GetItemInput{TableName: aws.String(f.table), Key: fileItemKey(o, id), ConsistentRead: aws.Bool(true)})
	if e != nil {
		return storedFile{}, e
	}
	if out.Item == nil {
		return storedFile{}, errFileNotFound
	}
	return fileFromItem(out.Item)
}
func (f *dynamoFileStore) List(_ context.Context, o string) ([]storedFile, error) {
	out, e := f.client.Query(&dynamodb.QueryInput{TableName: aws.String(f.table), KeyConditionExpression: aws.String("PK = :pk AND begins_with(SK, :prefix)"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":pk": {S: aws.String(sourceOwnerKey(o))}, ":prefix": {S: aws.String("FILE#")}}})
	if e != nil {
		return nil, e
	}
	r := make([]storedFile, 0, len(out.Items))
	for _, i := range out.Items {
		v, e := fileFromItem(i)
		if e != nil {
			return nil, e
		}
		r = append(r, v)
	}
	return r, nil
}
func (f *dynamoFileStore) Delete(_ context.Context, o, id string) error {
	_, e := f.client.DeleteItem(&dynamodb.DeleteItemInput{TableName: aws.String(f.table), Key: fileItemKey(o, id), ConditionExpression: aws.String("attribute_exists(PK)")})
	return e
}
func fileFromItem(i map[string]*dynamodb.AttributeValue) (storedFile, error) {
	s := func(k string) string {
		if a := i[k]; a != nil && a.S != nil {
			return *a.S
		}
		return ""
	}
	v := storedFile{ID: s("id"), Kind: s("kind"), ContentType: s("contentType"), Checksum: s("checksum"), Bucket: s("bucket"), ObjectKey: s("objectKey")}
	if a := i["sizeBytes"]; a != nil && a.N != nil {
		fmt.Sscan(*a.N, &v.SizeBytes)
	}
	var e error
	v.CreatedAt, e = time.Parse(time.RFC3339Nano, s("createdAt"))
	if e != nil {
		return v, e
	}
	if raw := s("origin"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &v.Origin)
	}
	if raw := s("retentionExpiresAt"); raw != "" {
		t, e := time.Parse(time.RFC3339Nano, raw)
		if e == nil {
			v.RetentionExpiresAt = &t
		}
	}
	return v, nil
}

var fileStoreFactory = func() fileStore {
	return newDynamoFileStore(os.Getenv("DOCUMENT_STORE_TABLE_NAME"), dynamodb.New(sess))
}

func ensurePrivateFileStorage(ctx context.Context, owner string, additional int64) error {
	files, err := fileStoreFactory().List(ctx, owner)
	if err != nil {
		return err
	}
	var used int64
	for _, file := range files {
		used += file.SizeBytes
	}
	if used+additional > maxPrivateFileStorageBytes {
		return &renderError{Code: "file_storage_limit_reached", Message: "Private file storage limit reached", Status: 409}
	}
	return nil
}

func isFileRequest(r events.APIGatewayProxyRequest) bool {
	p := r.Path
	if p == "" {
		p = r.Resource
	}
	return p == fileResource || strings.HasPrefix(p, fileResource+"/") || p == dashboardFileResource || strings.HasPrefix(p, dashboardFileResource+"/")
}
func filePath(r events.APIGatewayProxyRequest) []string {
	p := r.Path
	if p == "" {
		p = r.Resource
	}
	if strings.HasPrefix(p, dashboardFileResource) {
		return strings.Split(strings.Trim(strings.TrimPrefix(p, dashboardFileResource), "/"), "/")
	}
	return strings.Split(strings.Trim(strings.TrimPrefix(p, fileResource), "/"), "/")
}
func handleFileRequest(ctx context.Context, r events.APIGatewayProxyRequest, h map[string]string, store fileStore) events.APIGatewayProxyResponse {
	owner := authorizerValue(r, "userId")
	if owner == "" {
		return errorResponse(http.StatusUnauthorized, "Authentication is required", h)
	}
	parts := filePath(r)
	if len(parts) == 1 && parts[0] == "" {
		parts = nil
	}
	if r.HTTPMethod == http.MethodPost && len(parts) == 1 && parts[0] == "upload" {
		value, err := createPackageUpload(owner)
		if err != nil {
			return errorResponse(503, "File upload is temporarily unavailable", h)
		}
		return sourceJSON(http.StatusCreated, value, h)
	}
	if r.HTTPMethod == http.MethodGet && len(parts) == 0 {
		values, err := store.List(ctx, owner)
		if err != nil {
			return fileError(err, h)
		}
		return sourceJSON(http.StatusOK, map[string]any{"files": values}, h)
	}
	if len(parts) < 1 || len(parts) > 2 {
		return errorResponse(http.StatusNotFound, "Not found", h)
	}
	value, err := store.Get(ctx, owner, parts[0])
	if err != nil {
		return fileError(err, h)
	}
	if r.HTTPMethod == http.MethodGet && len(parts) == 2 && parts[1] == "download" {
		url, err := presignPrivateDownload(value.Bucket, value.ObjectKey)
		if err != nil {
			return errorResponse(503, "File download is temporarily unavailable", h)
		}
		return sourceJSON(http.StatusOK, map[string]string{"url": url}, h)
	}
	if r.HTTPMethod == http.MethodDelete && len(parts) == 1 {
		if err = store.Delete(ctx, owner, value.ID); err != nil {
			return fileError(err, h)
		}
		if err = deletePrivateObject(value.Bucket, value.ObjectKey); err != nil {
			fmt.Printf("file delete failed: %v\n", err)
		}
		return events.APIGatewayProxyResponse{StatusCode: http.StatusNoContent, Headers: h}
	}
	return errorResponse(http.StatusMethodNotAllowed, "Method not allowed", h)
}
func fileError(e error, h map[string]string) events.APIGatewayProxyResponse {
	if errors.Is(e, errFileNotFound) {
		return errorResponse(404, "File not found", h)
	}
	return errorResponse(503, "File storage is temporarily unavailable", h)
}
