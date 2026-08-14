package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/service/dynamodb"
)

const (
	maxTemplatesPerOwner      = 100
	maxTemplateHTMLBytes      = 1024 * 1024
	maxTemplateVariablesBytes = 256 * 1024
	templateItemPrefix        = "TEMPLATE#"
	templateCounterKey        = "META"
)

var (
	errTemplateNotFound     = errors.New("template not found")
	errTemplateLimitReached = errors.New("template limit reached")
)

// templateStore is deliberately owner-scoped: callers must provide the owner
// identity established by authentication, never one supplied in an HTTP body.
type templateStore interface {
	Create(context.Context, Template) error
	Get(context.Context, string, string) (Template, error)
	List(context.Context, string) ([]Template, error)
	Update(context.Context, Template) error
	Delete(context.Context, string, string) error
}

type templateDynamoDBAPI interface {
	DeleteItem(*dynamodb.DeleteItemInput) (*dynamodb.DeleteItemOutput, error)
	GetItem(*dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error)
	Query(*dynamodb.QueryInput) (*dynamodb.QueryOutput, error)
	TransactWriteItems(*dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error)
}

// dynamoTemplateStore persists templates in a dedicated DynamoDB table. The
// owner hash is the partition key, which makes cross-customer reads impossible
// unless the authenticated owner ID is deliberately changed by application code.
type dynamoTemplateStore struct {
	tableName string
	client    templateDynamoDBAPI
}

func newDynamoTemplateStore(tableName string, client templateDynamoDBAPI) *dynamoTemplateStore {
	return &dynamoTemplateStore{tableName: tableName, client: client}
}

func (store *dynamoTemplateStore) Create(ctx context.Context, template Template) error {
	if err := validateTemplateForStorage(template); err != nil {
		return err
	}
	if store.tableName == "" {
		return errors.New("template storage is not configured")
	}
	if store.client == nil {
		return errors.New("template storage client is not configured")
	}

	ownerKey := templateOwnerPartition(template.OwnerID)
	_, err := store.client.TransactWriteItems(&dynamodb.TransactWriteItemsInput{
		TransactItems: []*dynamodb.TransactWriteItem{
			{
				Update: &dynamodb.Update{
					TableName:           aws.String(store.tableName),
					Key:                 templateCounterItemKey(ownerKey),
					UpdateExpression:    aws.String("SET entityType = :entity ADD templateCount :one"),
					ConditionExpression: aws.String("attribute_not_exists(templateCount) OR templateCount < :limit"),
					ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
						":one":    {N: aws.String("1")},
						":limit":  {N: aws.String(strconv.Itoa(maxTemplatesPerOwner))},
						":entity": {S: aws.String("TEMPLATE_OWNER")},
					},
				},
			},
			{
				Put: &dynamodb.Put{
					TableName:           aws.String(store.tableName),
					Item:                templateItem(template, ownerKey),
					ConditionExpression: aws.String("attribute_not_exists(PK) AND attribute_not_exists(SK)"),
				},
			},
		},
	})
	if err != nil {
		if awsErr, ok := err.(awserr.Error); ok && awsErr.Code() == dynamodb.ErrCodeTransactionCanceledException {
			return errTemplateLimitReached
		}
		return fmt.Errorf("save template: %w", err)
	}
	return nil
}

func (store *dynamoTemplateStore) Get(ctx context.Context, ownerID, templateID string) (Template, error) {
	if strings.TrimSpace(ownerID) == "" || strings.TrimSpace(templateID) == "" {
		return Template{}, errTemplateNotFound
	}
	if store.tableName == "" || store.client == nil {
		return Template{}, errors.New("template storage is not configured")
	}
	result, err := store.client.GetItem(&dynamodb.GetItemInput{
		TableName:      aws.String(store.tableName),
		Key:            templateItemKey(templateOwnerPartition(ownerID), templateID),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return Template{}, fmt.Errorf("get template: %w", err)
	}
	if result.Item == nil {
		return Template{}, errTemplateNotFound
	}
	return templateFromItem(result.Item)
}

func (store *dynamoTemplateStore) List(ctx context.Context, ownerID string) ([]Template, error) {
	if strings.TrimSpace(ownerID) == "" {
		return nil, errTemplateNotFound
	}
	if store.tableName == "" || store.client == nil {
		return nil, errors.New("template storage is not configured")
	}
	result, err := store.client.Query(&dynamodb.QueryInput{
		TableName:              aws.String(store.tableName),
		KeyConditionExpression: aws.String("PK = :owner AND begins_with(SK, :prefix)"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":owner":  {S: aws.String(templateOwnerPartition(ownerID))},
			":prefix": {S: aws.String(templateItemPrefix)},
		},
		ConsistentRead: aws.Bool(true),
		Limit:          aws.Int64(maxTemplatesPerOwner),
	})
	if err != nil {
		return nil, fmt.Errorf("list templates: %w", err)
	}
	templates := make([]Template, 0, len(result.Items))
	for _, item := range result.Items {
		template, err := templateFromItem(item)
		if err != nil {
			return nil, err
		}
		templates = append(templates, template)
	}
	return templates, nil
}

func (store *dynamoTemplateStore) Update(ctx context.Context, template Template) error {
	if err := validateTemplateForStorage(template); err != nil {
		return err
	}
	if store.tableName == "" || store.client == nil {
		return errors.New("template storage is not configured")
	}
	ownerKey := templateOwnerPartition(template.OwnerID)
	_, err := store.client.TransactWriteItems(&dynamodb.TransactWriteItemsInput{TransactItems: []*dynamodb.TransactWriteItem{{
		Put: &dynamodb.Put{
			TableName:           aws.String(store.tableName),
			Item:                templateItem(template, ownerKey),
			ConditionExpression: aws.String("attribute_exists(PK) AND attribute_exists(SK)"),
		},
	}}})
	if err != nil {
		if awsErr, ok := err.(awserr.Error); ok && awsErr.Code() == dynamodb.ErrCodeTransactionCanceledException {
			return errTemplateNotFound
		}
		return fmt.Errorf("update template: %w", err)
	}
	return nil
}

func (store *dynamoTemplateStore) Delete(ctx context.Context, ownerID, templateID string) error {
	if strings.TrimSpace(ownerID) == "" || strings.TrimSpace(templateID) == "" {
		return errTemplateNotFound
	}
	if store.tableName == "" || store.client == nil {
		return errors.New("template storage is not configured")
	}
	ownerKey := templateOwnerPartition(ownerID)
	_, err := store.client.TransactWriteItems(&dynamodb.TransactWriteItemsInput{TransactItems: []*dynamodb.TransactWriteItem{
		{Delete: &dynamodb.Delete{
			TableName:           aws.String(store.tableName),
			Key:                 templateItemKey(ownerKey, templateID),
			ConditionExpression: aws.String("attribute_exists(PK) AND attribute_exists(SK)"),
		}},
		{Update: &dynamodb.Update{
			TableName:           aws.String(store.tableName),
			Key:                 templateCounterItemKey(ownerKey),
			UpdateExpression:    aws.String("ADD templateCount :minusOne"),
			ConditionExpression: aws.String("templateCount > :zero"),
			ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
				":minusOne": {N: aws.String("-1")},
				":zero":     {N: aws.String("0")},
			},
		}},
	}})
	if err != nil {
		if awsErr, ok := err.(awserr.Error); ok && awsErr.Code() == dynamodb.ErrCodeTransactionCanceledException {
			return errTemplateNotFound
		}
		return fmt.Errorf("delete template: %w", err)
	}
	return nil
}

func validateTemplateForStorage(template Template) error {
	if strings.TrimSpace(template.ID) == "" || strings.TrimSpace(template.Name) == "" || strings.TrimSpace(template.OwnerID) == "" {
		return templateVariableError(invalidTemplateVariableCode, "Template id, name, and ownerId are required")
	}
	if len(template.HTML) == 0 || len(template.HTML) > maxTemplateHTMLBytes {
		return templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Template HTML must be between 1 and %d bytes", maxTemplateHTMLBytes))
	}
	if template.Version < 1 {
		return templateVariableError(invalidTemplateVariableCode, "Template version must be at least 1")
	}
	if !validTemplateType(template.Type) {
		return templateVariableError(invalidTemplateVariableCode, "Template type must be invoice, contract, certificate, receipt, or custom")
	}
	if template.Variables != nil {
		encoded, err := json.Marshal(template.Variables)
		if err != nil || len(encoded) > maxTemplateVariablesBytes {
			return templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Template variables must be valid JSON up to %d bytes", maxTemplateVariablesBytes))
		}
		if _, err := renderTemplateHTML(template.HTML, template.Variables); err != nil {
			return err
		}
	}
	return nil
}

func validTemplateType(templateType TemplateType) bool {
	switch templateType {
	case TemplateTypeInvoice, TemplateTypeContract, TemplateTypeCertificate, TemplateTypeReceipt, TemplateTypeCustom:
		return true
	default:
		return false
	}
}

func templateOwnerPartition(ownerID string) string {
	digest := sha256.Sum256([]byte("renderpdf-template-owner:" + ownerID))
	return "OWNER#" + hex.EncodeToString(digest[:])
}

func templateItemKey(ownerKey, templateID string) map[string]*dynamodb.AttributeValue {
	return map[string]*dynamodb.AttributeValue{
		"PK": {S: aws.String(ownerKey)},
		"SK": {S: aws.String(templateItemPrefix + templateID)},
	}
}

func templateCounterItemKey(ownerKey string) map[string]*dynamodb.AttributeValue {
	return map[string]*dynamodb.AttributeValue{
		"PK": {S: aws.String(ownerKey)},
		"SK": {S: aws.String(templateCounterKey)},
	}
}

func templateItem(template Template, ownerKey string) map[string]*dynamodb.AttributeValue {
	item := templateItemKey(ownerKey, template.ID)
	item["entityType"] = &dynamodb.AttributeValue{S: aws.String("TEMPLATE")}
	item["id"] = &dynamodb.AttributeValue{S: aws.String(template.ID)}
	item["name"] = &dynamodb.AttributeValue{S: aws.String(template.Name)}
	item["type"] = &dynamodb.AttributeValue{S: aws.String(string(template.Type))}
	item["html"] = &dynamodb.AttributeValue{S: aws.String(template.HTML)}
	if template.Variables != nil {
		variables, _ := json.Marshal(template.Variables)
		item["variables"] = &dynamodb.AttributeValue{S: aws.String(string(variables))}
	}
	item["ownerId"] = &dynamodb.AttributeValue{S: aws.String(template.OwnerID)}
	item["createdAt"] = &dynamodb.AttributeValue{S: aws.String(template.CreatedAt.UTC().Format(time.RFC3339Nano))}
	item["updatedAt"] = &dynamodb.AttributeValue{S: aws.String(template.UpdatedAt.UTC().Format(time.RFC3339Nano))}
	item["version"] = &dynamodb.AttributeValue{N: aws.String(strconv.Itoa(template.Version))}
	return item
}

func templateFromItem(item map[string]*dynamodb.AttributeValue) (Template, error) {
	value := func(name string) (string, error) {
		attribute := item[name]
		if attribute == nil || attribute.S == nil {
			return "", fmt.Errorf("template item is missing %s", name)
		}
		return *attribute.S, nil
	}
	var template Template
	var err error
	if template.ID, err = value("id"); err != nil {
		return Template{}, err
	}
	if template.Name, err = value("name"); err != nil {
		return Template{}, err
	}
	templateType, err := value("type")
	if err != nil {
		return Template{}, err
	}
	template.Type = TemplateType(templateType)
	if template.HTML, err = value("html"); err != nil {
		return Template{}, err
	}
	if attribute := item["variables"]; attribute != nil && attribute.S != nil {
		if err := json.Unmarshal([]byte(*attribute.S), &template.Variables); err != nil {
			return Template{}, fmt.Errorf("parse variables: %w", err)
		}
	}
	if template.OwnerID, err = value("ownerId"); err != nil {
		return Template{}, err
	}
	createdAt, err := value("createdAt")
	if err != nil {
		return Template{}, err
	}
	updatedAt, err := value("updatedAt")
	if err != nil {
		return Template{}, err
	}
	if template.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt); err != nil {
		return Template{}, fmt.Errorf("parse createdAt: %w", err)
	}
	if template.UpdatedAt, err = time.Parse(time.RFC3339Nano, updatedAt); err != nil {
		return Template{}, fmt.Errorf("parse updatedAt: %w", err)
	}
	version, err := valueNumber(item, "version")
	if err != nil {
		return Template{}, err
	}
	if template.Version, err = strconv.Atoi(version); err != nil {
		return Template{}, fmt.Errorf("parse version: %w", err)
	}
	return template, nil
}

func valueNumber(item map[string]*dynamodb.AttributeValue, name string) (string, error) {
	attribute := item[name]
	if attribute == nil || attribute.N == nil {
		return "", fmt.Errorf("template item is missing %s", name)
	}
	return *attribute.N, nil
}
