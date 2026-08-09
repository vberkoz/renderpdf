package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/service/dynamodb"
)

const (
	templateSharePrefix  = "SHARE#"
	sharedTemplatePrefix = "SHARED#"
	maxSharesPerTemplate = 100
)

var (
	errTemplateShareNotFound = errors.New("template share not found")
	errTemplateShareExists   = errors.New("template share already exists")
	errTemplateShareLimit    = errors.New("template share limit reached")
)

type TemplateShareRole string

const (
	TemplateShareRoleOwner  TemplateShareRole = "owner"
	TemplateShareRoleViewer TemplateShareRole = "viewer"
	TemplateShareRoleEditor TemplateShareRole = "editor"
)

type TemplateShare struct {
	TemplateID  string            `json:"templateId"`
	OwnerID     string            `json:"ownerId"`
	RecipientID string            `json:"recipientId"`
	Role        TemplateShareRole `json:"role"`
	CreatedAt   time.Time         `json:"createdAt"`
	UpdatedAt   time.Time         `json:"updatedAt"`
}

type SharedTemplate struct {
	Template
	Access TemplateShareRole `json:"access"`
}

// templateShareStore is an optional extension so the original owner-scoped
// store remains usable in focused tests while production gains sharing.
type templateShareStore interface {
	templateStore
	GetAccessible(context.Context, string, string) (Template, TemplateShareRole, error)
	ListShared(context.Context, string) ([]SharedTemplate, error)
	CreateShare(context.Context, TemplateShare) error
	ListShares(context.Context, string, string) ([]TemplateShare, error)
	UpdateShare(context.Context, TemplateShare) error
	DeleteShare(context.Context, string, string, string) error
}

func getAccessibleTemplate(ctx context.Context, store templateStore, requesterID, templateID string) (Template, TemplateShareRole, error) {
	if shares, ok := store.(templateShareStore); ok {
		return shares.GetAccessible(ctx, requesterID, templateID)
	}
	template, err := store.Get(ctx, requesterID, templateID)
	return template, TemplateShareRoleOwner, err
}

func (store *dynamoTemplateStore) GetAccessible(ctx context.Context, requesterID, templateID string) (Template, TemplateShareRole, error) {
	if template, err := store.Get(ctx, requesterID, templateID); err == nil {
		return template, TemplateShareRoleOwner, nil
	} else if !errors.Is(err, errTemplateNotFound) {
		return Template{}, "", err
	}
	shares, err := store.sharedByRecipient(ctx, requesterID)
	if err != nil {
		return Template{}, "", err
	}
	for _, share := range shares {
		if share.TemplateID == templateID {
			template, err := store.Get(ctx, share.OwnerID, templateID)
			if err != nil {
				return Template{}, "", errTemplateNotFound
			}
			return template, share.Role, nil
		}
	}
	return Template{}, "", errTemplateNotFound
}

func (store *dynamoTemplateStore) ListShared(ctx context.Context, recipientID string) ([]SharedTemplate, error) {
	shares, err := store.sharedByRecipient(ctx, recipientID)
	if err != nil {
		return nil, err
	}
	result := make([]SharedTemplate, 0, len(shares))
	for _, share := range shares {
		template, err := store.Get(ctx, share.OwnerID, share.TemplateID)
		if errors.Is(err, errTemplateNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		result = append(result, SharedTemplate{Template: template, Access: share.Role})
	}
	return result, nil
}

func (store *dynamoTemplateStore) CreateShare(ctx context.Context, share TemplateShare) error {
	if err := validateTemplateShare(share); err != nil {
		return err
	}
	if store.tableName == "" || store.client == nil {
		return errors.New("template storage is not configured")
	}
	if lenShares, err := store.ListShares(ctx, share.OwnerID, share.TemplateID); err != nil {
		return err
	} else if len(lenShares) >= maxSharesPerTemplate {
		return errTemplateShareLimit
	}
	items := []*dynamodb.TransactWriteItem{
		{Put: &dynamodb.Put{TableName: aws.String(store.tableName), Item: templateShareItem(share, false), ConditionExpression: aws.String("attribute_not_exists(PK) AND attribute_not_exists(SK)")}},
		{Put: &dynamodb.Put{TableName: aws.String(store.tableName), Item: templateShareItem(share, true), ConditionExpression: aws.String("attribute_not_exists(PK) AND attribute_not_exists(SK)")}},
	}
	_, err := store.client.TransactWriteItems(&dynamodb.TransactWriteItemsInput{TransactItems: items})
	if err != nil {
		if awsErr, ok := err.(awserr.Error); ok && awsErr.Code() == dynamodb.ErrCodeTransactionCanceledException {
			return errTemplateShareExists
		}
		return fmt.Errorf("create template share: %w", err)
	}
	return nil
}

func (store *dynamoTemplateStore) ListShares(_ context.Context, ownerID, templateID string) ([]TemplateShare, error) {
	if store.tableName == "" || store.client == nil {
		return nil, errors.New("template storage is not configured")
	}
	result, err := store.client.Query(&dynamodb.QueryInput{
		TableName: aws.String(store.tableName), KeyConditionExpression: aws.String("PK = :owner AND begins_with(SK, :prefix)"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":owner":  {S: aws.String(templateOwnerPartition(ownerID))},
			":prefix": {S: aws.String(templateSharePrefix + templateID + "#")},
		}, ConsistentRead: aws.Bool(true), Limit: aws.Int64(maxSharesPerTemplate),
	})
	if err != nil {
		return nil, fmt.Errorf("list template shares: %w", err)
	}
	return templateSharesFromItems(result.Items)
}

func (store *dynamoTemplateStore) UpdateShare(ctx context.Context, share TemplateShare) error {
	if err := validateTemplateShare(share); err != nil {
		return err
	}
	existing, err := store.getShare(ctx, share.OwnerID, share.TemplateID, share.RecipientID)
	if err != nil {
		return err
	}
	share.CreatedAt = existing.CreatedAt
	items := []*dynamodb.TransactWriteItem{
		{Put: &dynamodb.Put{TableName: aws.String(store.tableName), Item: templateShareItem(share, false), ConditionExpression: aws.String("attribute_exists(PK) AND attribute_exists(SK)")}},
		{Put: &dynamodb.Put{TableName: aws.String(store.tableName), Item: templateShareItem(share, true), ConditionExpression: aws.String("attribute_exists(PK) AND attribute_exists(SK)")}},
	}
	_, err = store.client.TransactWriteItems(&dynamodb.TransactWriteItemsInput{TransactItems: items})
	if err != nil {
		return errTemplateShareNotFound
	}
	return nil
}

func (store *dynamoTemplateStore) DeleteShare(_ context.Context, ownerID, templateID, recipientID string) error {
	if store.tableName == "" || store.client == nil {
		return errors.New("template storage is not configured")
	}
	share := TemplateShare{OwnerID: ownerID, TemplateID: templateID, RecipientID: recipientID}
	items := []*dynamodb.TransactWriteItem{
		{Delete: &dynamodb.Delete{TableName: aws.String(store.tableName), Key: templateShareKey(share, false), ConditionExpression: aws.String("attribute_exists(PK) AND attribute_exists(SK)")}},
		{Delete: &dynamodb.Delete{TableName: aws.String(store.tableName), Key: templateShareKey(share, true), ConditionExpression: aws.String("attribute_exists(PK) AND attribute_exists(SK)")}},
	}
	_, err := store.client.TransactWriteItems(&dynamodb.TransactWriteItemsInput{TransactItems: items})
	if err != nil {
		return errTemplateShareNotFound
	}
	return nil
}

func (store *dynamoTemplateStore) sharedByRecipient(_ context.Context, recipientID string) ([]TemplateShare, error) {
	if store.tableName == "" || store.client == nil {
		return nil, errors.New("template storage is not configured")
	}
	result, err := store.client.Query(&dynamodb.QueryInput{
		TableName: aws.String(store.tableName), KeyConditionExpression: aws.String("PK = :recipient AND begins_with(SK, :prefix)"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":recipient": {S: aws.String(templateOwnerPartition(recipientID))}, ":prefix": {S: aws.String(sharedTemplatePrefix)},
		}, ConsistentRead: aws.Bool(true), Limit: aws.Int64(maxSharesPerTemplate),
	})
	if err != nil {
		return nil, fmt.Errorf("list shared templates: %w", err)
	}
	return templateSharesFromItems(result.Items)
}

func (store *dynamoTemplateStore) getShare(_ context.Context, ownerID, templateID, recipientID string) (TemplateShare, error) {
	share := TemplateShare{OwnerID: ownerID, TemplateID: templateID, RecipientID: recipientID}
	result, err := store.client.GetItem(&dynamodb.GetItemInput{TableName: aws.String(store.tableName), Key: templateShareKey(share, false), ConsistentRead: aws.Bool(true)})
	if err != nil {
		return TemplateShare{}, err
	}
	if result.Item == nil {
		return TemplateShare{}, errTemplateShareNotFound
	}
	return templateShareFromItem(result.Item)
}

func validateTemplateShare(share TemplateShare) error {
	if strings.TrimSpace(share.OwnerID) == "" || strings.TrimSpace(share.RecipientID) == "" || strings.TrimSpace(share.TemplateID) == "" {
		return templateVariableError(invalidTemplateVariableCode, "templateId and recipientId are required")
	}
	if share.OwnerID == share.RecipientID {
		return templateVariableError(invalidTemplateVariableCode, "A template cannot be shared with its owner")
	}
	if share.Role != TemplateShareRoleViewer && share.Role != TemplateShareRoleEditor {
		return templateVariableError(invalidTemplateVariableCode, "Share role must be viewer or editor")
	}
	return nil
}

func templateShareKey(share TemplateShare, recipientCopy bool) map[string]*dynamodb.AttributeValue {
	if recipientCopy {
		return map[string]*dynamodb.AttributeValue{"PK": {S: aws.String(templateOwnerPartition(share.RecipientID))}, "SK": {S: aws.String(sharedTemplatePrefix + templateOwnerPartition(share.OwnerID) + "#" + share.TemplateID)}}
	}
	return map[string]*dynamodb.AttributeValue{"PK": {S: aws.String(templateOwnerPartition(share.OwnerID))}, "SK": {S: aws.String(templateSharePrefix + share.TemplateID + "#" + templateOwnerPartition(share.RecipientID))}}
}

func templateShareItem(share TemplateShare, recipientCopy bool) map[string]*dynamodb.AttributeValue {
	item := templateShareKey(share, recipientCopy)
	item["entityType"] = &dynamodb.AttributeValue{S: aws.String("TEMPLATE_SHARE")}
	item["templateId"] = &dynamodb.AttributeValue{S: aws.String(share.TemplateID)}
	item["ownerId"] = &dynamodb.AttributeValue{S: aws.String(share.OwnerID)}
	item["recipientId"] = &dynamodb.AttributeValue{S: aws.String(share.RecipientID)}
	item["role"] = &dynamodb.AttributeValue{S: aws.String(string(share.Role))}
	item["createdAt"] = &dynamodb.AttributeValue{S: aws.String(share.CreatedAt.UTC().Format(time.RFC3339Nano))}
	item["updatedAt"] = &dynamodb.AttributeValue{S: aws.String(share.UpdatedAt.UTC().Format(time.RFC3339Nano))}
	return item
}

func templateSharesFromItems(items []map[string]*dynamodb.AttributeValue) ([]TemplateShare, error) {
	shares := make([]TemplateShare, 0, len(items))
	for _, item := range items {
		share, err := templateShareFromItem(item)
		if err != nil {
			return nil, err
		}
		shares = append(shares, share)
	}
	return shares, nil
}

func templateShareFromItem(item map[string]*dynamodb.AttributeValue) (TemplateShare, error) {
	value := func(name string) (string, error) {
		attribute := item[name]
		if attribute == nil || attribute.S == nil {
			return "", fmt.Errorf("template share item is missing %s", name)
		}
		return *attribute.S, nil
	}
	var share TemplateShare
	var err error
	if share.TemplateID, err = value("templateId"); err != nil {
		return share, err
	}
	if share.OwnerID, err = value("ownerId"); err != nil {
		return share, err
	}
	if share.RecipientID, err = value("recipientId"); err != nil {
		return share, err
	}
	role, err := value("role")
	if err != nil {
		return share, err
	}
	share.Role = TemplateShareRole(role)
	created, err := value("createdAt")
	if err != nil {
		return share, err
	}
	share.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	if err != nil {
		return share, err
	}
	updated, err := value("updatedAt")
	if err != nil {
		return share, err
	}
	share.UpdatedAt, err = time.Parse(time.RFC3339Nano, updated)
	if err != nil {
		return share, err
	}
	return share, nil
}
