package main

import (
	"context"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/service/dynamodb"
)

// memoryTemplateDynamo models the durable DynamoDB table across Lambda
// instances without requiring AWS credentials in unit tests.
type memoryTemplateDynamo struct {
	items  map[string]map[string]*dynamodb.AttributeValue
	counts map[string]int
}

func (database *memoryTemplateDynamo) TransactWriteItems(input *dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error) {
	if database.items == nil {
		database.items = map[string]map[string]*dynamodb.AttributeValue{}
		database.counts = map[string]int{}
	}
	item := input.TransactItems[1].Put.Item
	owner := aws.StringValue(item["PK"].S)
	if database.counts[owner] >= maxTemplatesPerOwner {
		return nil, awserr.New(dynamodb.ErrCodeTransactionCanceledException, "template limit", nil)
	}
	key := owner + "/" + aws.StringValue(item["SK"].S)
	if _, exists := database.items[key]; exists {
		return nil, awserr.New(dynamodb.ErrCodeTransactionCanceledException, "template exists", nil)
	}
	database.items[key] = item
	database.counts[owner]++
	return &dynamodb.TransactWriteItemsOutput{}, nil
}

func (database *memoryTemplateDynamo) GetItem(input *dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error) {
	key := aws.StringValue(input.Key["PK"].S) + "/" + aws.StringValue(input.Key["SK"].S)
	return &dynamodb.GetItemOutput{Item: database.items[key]}, nil
}

func (database *memoryTemplateDynamo) Query(_ *dynamodb.QueryInput) (*dynamodb.QueryOutput, error) {
	return &dynamodb.QueryOutput{}, nil
}

func (database *memoryTemplateDynamo) DeleteItem(_ *dynamodb.DeleteItemInput) (*dynamodb.DeleteItemOutput, error) {
	return &dynamodb.DeleteItemOutput{}, nil
}

func testTemplate(ownerID, id string) Template {
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	return Template{
		ID:        id,
		Name:      "Invoice",
		Type:      TemplateTypeInvoice,
		HTML:      `<p>{{customer.name}}</p>`,
		OwnerID:   ownerID,
		CreatedAt: now,
		UpdatedAt: now,
		Version:   1,
	}
}

func TestDynamoTemplateStorePersistsAcrossStoreInstances(t *testing.T) {
	database := &memoryTemplateDynamo{}
	firstInstance := newDynamoTemplateStore("templates", database)
	if err := firstInstance.Create(context.Background(), testTemplate("customer-a", "invoice-1")); err != nil {
		t.Fatalf("create: %v", err)
	}

	// A new repository instance uses the same durable backing store, mirroring a
	// new Lambda process after deployment or restart.
	restartedInstance := newDynamoTemplateStore("templates", database)
	template, err := restartedInstance.Get(context.Background(), "customer-a", "invoice-1")
	if err != nil {
		t.Fatalf("get after restart: %v", err)
	}
	if template.Name != "Invoice" || template.Version != 1 {
		t.Fatalf("template = %#v", template)
	}
}

func TestDynamoTemplateStorePreventsCrossCustomerReads(t *testing.T) {
	store := newDynamoTemplateStore("templates", &memoryTemplateDynamo{})
	if err := store.Create(context.Background(), testTemplate("customer-a", "invoice-1")); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := store.Get(context.Background(), "customer-b", "invoice-1"); err != errTemplateNotFound {
		t.Fatalf("cross-customer read error = %v, want %v", err, errTemplateNotFound)
	}
}

func TestDynamoTemplateStoreEnforcesPerCustomerLimit(t *testing.T) {
	store := newDynamoTemplateStore("templates", &memoryTemplateDynamo{})
	for number := 0; number < maxTemplatesPerOwner; number++ {
		if err := store.Create(context.Background(), testTemplate("customer-a", string(rune('a'+number)))); err != nil {
			t.Fatalf("create template %d: %v", number, err)
		}
	}
	if err := store.Create(context.Background(), testTemplate("customer-a", "overflow")); err != errTemplateLimitReached {
		t.Fatalf("overflow error = %v, want %v", err, errTemplateLimitReached)
	}
}
