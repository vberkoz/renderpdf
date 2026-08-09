package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/google/uuid"
)

const publicTemplateLinkPrefix = "PUBLIC_LINK#"

var errPublicTemplateLinkNotFound = errors.New("public template link not found")

type PublicTemplateLink struct {
	ID         string    `json:"id"`
	TemplateID string    `json:"templateId"`
	OwnerID    string    `json:"ownerId"`
	Token      string    `json:"token,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

type publicTemplateStore interface {
	templateStore
	CreatePublicLink(context.Context, PublicTemplateLink) (PublicTemplateLink, error)
	ListPublicLinks(context.Context, string, string) ([]PublicTemplateLink, error)
	DeletePublicLink(context.Context, string, string, string) error
	GetPublicTemplate(context.Context, string) (Template, error)
}

func publicToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func publicTokenKey(token string) string {
	digest := sha256.Sum256([]byte("renderpdf-public-template:" + token))
	return "PUBLIC#" + fmt.Sprintf("%x", digest[:])
}

func (store *dynamoTemplateStore) CreatePublicLink(_ context.Context, link PublicTemplateLink) (PublicTemplateLink, error) {
	if store.tableName == "" || store.client == nil {
		return PublicTemplateLink{}, errors.New("template storage is not configured")
	}
	token, err := publicToken()
	if err != nil {
		return PublicTemplateLink{}, err
	}
	link.ID, link.Token = uuid.NewString(), token
	lookup := publicLinkItem(link, true)
	owner := publicLinkItem(link, false)
	_, err = store.client.TransactWriteItems(&dynamodb.TransactWriteItemsInput{TransactItems: []*dynamodb.TransactWriteItem{
		{Put: &dynamodb.Put{TableName: aws.String(store.tableName), Item: lookup, ConditionExpression: aws.String("attribute_not_exists(PK) AND attribute_not_exists(SK)")}},
		{Put: &dynamodb.Put{TableName: aws.String(store.tableName), Item: owner, ConditionExpression: aws.String("attribute_not_exists(PK) AND attribute_not_exists(SK)")}},
	}})
	if err != nil {
		return PublicTemplateLink{}, fmt.Errorf("create public template link: %w", err)
	}
	return link, nil
}

func (store *dynamoTemplateStore) ListPublicLinks(_ context.Context, ownerID, templateID string) ([]PublicTemplateLink, error) {
	result, err := store.client.Query(&dynamodb.QueryInput{TableName: aws.String(store.tableName), KeyConditionExpression: aws.String("PK = :owner AND begins_with(SK, :prefix)"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":owner": {S: aws.String(templateOwnerPartition(ownerID))}, ":prefix": {S: aws.String(publicTemplateLinkPrefix + templateID + "#")}}, ConsistentRead: aws.Bool(true)})
	if err != nil {
		return nil, err
	}
	links := make([]PublicTemplateLink, 0, len(result.Items))
	for _, item := range result.Items {
		link, err := publicLinkFromItem(item)
		if err != nil {
			return nil, err
		}
		links = append(links, link)
	}
	return links, nil
}

func (store *dynamoTemplateStore) DeletePublicLink(ctx context.Context, ownerID, templateID, linkID string) error {
	links, err := store.ListPublicLinks(ctx, ownerID, templateID)
	if err != nil {
		return err
	}
	var link PublicTemplateLink
	found := false
	for _, candidate := range links {
		if candidate.ID == linkID {
			link = candidate
			found = true
			break
		}
	}
	if !found {
		return errPublicTemplateLinkNotFound
	}
	_, err = store.client.TransactWriteItems(&dynamodb.TransactWriteItemsInput{TransactItems: []*dynamodb.TransactWriteItem{
		{Delete: &dynamodb.Delete{TableName: aws.String(store.tableName), Key: publicLinkKey(link, true), ConditionExpression: aws.String("attribute_exists(PK)")}},
		{Delete: &dynamodb.Delete{TableName: aws.String(store.tableName), Key: publicLinkKey(link, false), ConditionExpression: aws.String("attribute_exists(PK)")}},
	}})
	if err != nil {
		return errPublicTemplateLinkNotFound
	}
	return nil
}

func (store *dynamoTemplateStore) GetPublicTemplate(_ context.Context, token string) (Template, error) {
	result, err := store.client.GetItem(&dynamodb.GetItemInput{TableName: aws.String(store.tableName), Key: map[string]*dynamodb.AttributeValue{"PK": {S: aws.String(publicTokenKey(token))}, "SK": {S: aws.String("LINK")}}, ConsistentRead: aws.Bool(true)})
	if err != nil || result.Item == nil {
		return Template{}, errPublicTemplateLinkNotFound
	}
	link, err := publicLinkFromItem(result.Item)
	if err != nil {
		return Template{}, err
	}
	return store.Get(context.Background(), link.OwnerID, link.TemplateID)
}

func publicLinkKey(link PublicTemplateLink, lookup bool) map[string]*dynamodb.AttributeValue {
	if lookup {
		return map[string]*dynamodb.AttributeValue{"PK": {S: aws.String(publicTokenKey(link.Token))}, "SK": {S: aws.String("LINK")}}
	}
	return map[string]*dynamodb.AttributeValue{"PK": {S: aws.String(templateOwnerPartition(link.OwnerID))}, "SK": {S: aws.String(publicTemplateLinkPrefix + link.TemplateID + "#" + link.ID)}}
}
func publicLinkItem(link PublicTemplateLink, lookup bool) map[string]*dynamodb.AttributeValue {
	item := publicLinkKey(link, lookup)
	item["entityType"] = &dynamodb.AttributeValue{S: aws.String("PUBLIC_TEMPLATE_LINK")}
	item["id"] = &dynamodb.AttributeValue{S: aws.String(link.ID)}
	item["templateId"] = &dynamodb.AttributeValue{S: aws.String(link.TemplateID)}
	item["ownerId"] = &dynamodb.AttributeValue{S: aws.String(link.OwnerID)}
	item["createdAt"] = &dynamodb.AttributeValue{S: aws.String(link.CreatedAt.UTC().Format(time.RFC3339Nano))}
	return item
}
func publicLinkFromItem(item map[string]*dynamodb.AttributeValue) (PublicTemplateLink, error) {
	get := func(n string) (string, error) {
		if item[n] == nil || item[n].S == nil {
			return "", fmt.Errorf("public template link missing %s", n)
		}
		return *item[n].S, nil
	}
	var l PublicTemplateLink
	var e error
	if l.ID, e = get("id"); e != nil {
		return l, e
	}
	if l.TemplateID, e = get("templateId"); e != nil {
		return l, e
	}
	if l.OwnerID, e = get("ownerId"); e != nil {
		return l, e
	}
	created, e := get("createdAt")
	if e != nil {
		return l, e
	}
	l.CreatedAt, e = time.Parse(time.RFC3339Nano, created)
	return l, e
}

func isPublicLinkConflict(err error) bool {
	awsErr, ok := err.(awserr.Error)
	return ok && awsErr.Code() == dynamodb.ErrCodeTransactionCanceledException
}
