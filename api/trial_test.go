package main

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/service/dynamodb"
)

func TestTrialViewerIPUsesCloudFrontInjectedHeader(t *testing.T) {
	request := events.APIGatewayProxyRequest{
		Headers: map[string]string{"x-renderpdf-viewer-ip": "203.0.113.8"},
		RequestContext: events.APIGatewayProxyRequestContext{
			Identity: events.APIGatewayRequestIdentity{SourceIP: "198.51.100.4"},
		},
	}

	if got := trialViewerIP(request); got != "203.0.113.8" {
		t.Fatalf("expected viewer IP, got %q", got)
	}
}

func TestTrialViewerIPRejectsInvalidInjectedHeader(t *testing.T) {
	request := events.APIGatewayProxyRequest{
		Headers: map[string]string{"X-RenderPDF-Viewer-IP": "not-an-ip"},
		RequestContext: events.APIGatewayProxyRequestContext{
			Identity: events.APIGatewayRequestIdentity{SourceIP: "198.51.100.4"},
		},
	}

	if got := trialViewerIP(request); got != "198.51.100.4" {
		t.Fatalf("expected API Gateway source IP fallback, got %q", got)
	}
}

type fakeDynamoDB struct {
	updateInput  *dynamodb.UpdateItemInput
	updateInputs []*dynamodb.UpdateItemInput
	putInput     *dynamodb.PutItemInput
	updateErr    error
	updateErrors []error
	count        string
}

func (f *fakeDynamoDB) GetItem(*dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error) {
	return &dynamodb.GetItemOutput{}, nil
}

func (f *fakeDynamoDB) PutItem(input *dynamodb.PutItemInput) (*dynamodb.PutItemOutput, error) {
	f.putInput = input
	return &dynamodb.PutItemOutput{}, nil
}

func (f *fakeDynamoDB) UpdateItem(input *dynamodb.UpdateItemInput) (*dynamodb.UpdateItemOutput, error) {
	f.updateInput = input
	f.updateInputs = append(f.updateInputs, input)
	if len(f.updateErrors) > 0 {
		err := f.updateErrors[0]
		f.updateErrors = f.updateErrors[1:]
		if err != nil {
			return nil, err
		}
	}
	if f.updateErr != nil {
		return nil, f.updateErr
	}
	return &dynamodb.UpdateItemOutput{Attributes: map[string]*dynamodb.AttributeValue{
		"requestCount": {N: aws.String(f.count)},
	}}, nil
}

func TestAcquireTrialSlotUsesSecondAvailableSlot(t *testing.T) {
	previousClient, previousTable := ddbClient, tableName
	t.Cleanup(func() {
		ddbClient, tableName = previousClient, previousTable
	})

	occupied := awserr.New(dynamodb.ErrCodeConditionalCheckFailedException, "occupied", nil)
	fake := &fakeDynamoDB{updateErrors: []error{occupied, nil}}
	ddbClient = fake
	tableName = "renderpdf-usage"

	slot, err := acquireTrialSlot("request-1", time.Now())
	if err != nil {
		t.Fatalf("acquireTrialSlot returned an error: %v", err)
	}
	if slot.Number != 2 || slot.Owner != "request-1" {
		t.Fatalf("unexpected slot: %+v", slot)
	}
	if len(fake.updateInputs) != 2 {
		t.Fatalf("expected two slot attempts, got %d", len(fake.updateInputs))
	}
}

func TestAcquireTrialSlotRejectsWhenFull(t *testing.T) {
	previousClient := ddbClient
	t.Cleanup(func() { ddbClient = previousClient })

	occupied := awserr.New(dynamodb.ErrCodeConditionalCheckFailedException, "occupied", nil)
	ddbClient = &fakeDynamoDB{updateErrors: []error{occupied, occupied}}

	_, err := acquireTrialSlot("request-1", time.Now())
	if !errors.Is(err, errTrialCapacityReached) {
		t.Fatalf("expected capacity error, got %v", err)
	}
}

func TestTrialQuotaKeyIsStableAndDaily(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	now := time.Date(2026, time.July, 29, 12, 0, 0, 0, time.UTC)

	first := trialQuotaKey(secret, "203.0.113.8", now)
	second := trialQuotaKey(secret, "203.0.113.8", now.Add(time.Hour))
	nextDay := trialQuotaKey(secret, "203.0.113.8", now.Add(24*time.Hour))
	otherIP := trialQuotaKey(secret, "203.0.113.9", now)

	if first != second {
		t.Fatal("same IP should use one quota key throughout the UTC day")
	}
	if first == nextDay || first == otherIP {
		t.Fatal("quota key should change for a new UTC day or source IP")
	}
	if strings.Contains(first, "203.0.113.8") {
		t.Fatal("quota key must not expose the source IP")
	}
}

func TestConsumeTrialQuotaUsesSingleTableItem(t *testing.T) {
	previousClient, previousTable, previousSecret := ddbClient, tableName, trialSecret
	t.Cleanup(func() {
		ddbClient, tableName, trialSecret = previousClient, previousTable, previousSecret
	})

	fake := &fakeDynamoDB{count: "2"}
	ddbClient = fake
	tableName = "renderpdf-usage"
	trialSecret = []byte("01234567890123456789012345678901")
	t.Setenv("TRIAL_DAILY_LIMIT", "3")

	quota, err := consumeTrialQuota("203.0.113.8", time.Date(2026, time.July, 29, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("consumeTrialQuota returned an error: %v", err)
	}
	if quota.Remaining != 1 || quota.Limit != 3 {
		t.Fatalf("unexpected quota response: %+v", quota)
	}
	if aws.StringValue(fake.updateInput.TableName) != "renderpdf-usage" {
		t.Fatal("trial quota must use the existing usage table")
	}
	if aws.StringValue(fake.updateInput.Key["timestamp"].N) != "0" {
		t.Fatal("trial quota item must use the usage table sort key")
	}
	if !strings.HasPrefix(aws.StringValue(fake.updateInput.Key["requestId"].S), "TRIAL#") {
		t.Fatal("trial quota item must use the TRIAL entity prefix")
	}
}

func TestConsumeTrialQuotaReturnsLimitError(t *testing.T) {
	previousClient, previousSecret := ddbClient, trialSecret
	t.Cleanup(func() {
		ddbClient, trialSecret = previousClient, previousSecret
	})

	ddbClient = &fakeDynamoDB{updateErr: awserr.New(dynamodb.ErrCodeConditionalCheckFailedException, "limit", nil)}
	trialSecret = []byte("01234567890123456789012345678901")
	_, err := consumeTrialQuota("203.0.113.8", time.Now())
	if !errors.Is(err, errTrialLimitExceeded) {
		t.Fatalf("expected trial limit error, got %v", err)
	}
}

func TestPositiveEnvIntFallsBack(t *testing.T) {
	t.Setenv("TEST_LIMIT", "not-a-number")
	if value := positiveEnvInt("TEST_LIMIT", 3); value != 3 {
		t.Fatalf("expected fallback, got %d", value)
	}
	t.Setenv("TEST_LIMIT", "5")
	if value := positiveEnvInt("TEST_LIMIT", 3); value != 5 {
		t.Fatalf("expected configured value, got %d", value)
	}
}
