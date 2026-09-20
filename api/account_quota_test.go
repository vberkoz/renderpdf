package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/service/dynamodb"
)

func TestAccountQuotaReservationAndRefund(t *testing.T) {
	previousClient, previousTable := ddbClient, tableName
	t.Cleanup(func() {
		ddbClient, tableName = previousClient, previousTable
	})
	t.Setenv("FREE_MONTHLY_QUOTA", "25")
	fake := &fakeDynamoDB{}
	ddbClient, tableName = fake, "renderpdf-usage"
	now := time.Date(2026, time.August, 19, 10, 0, 0, 0, time.UTC)

	quota, err := reserveAccountQuota("customer-123", "", now)
	if err != nil {
		t.Fatalf("reserve account quota: %v", err)
	}
	if quota == nil || quota.Key != "USER_QUOTA#customer-123#2026-08" {
		t.Fatalf("quota = %#v", quota)
	}
	if len(fake.updateInputs) != 1 || aws.StringValue(fake.updateInputs[0].ExpressionAttributeValues[":limit"].N) != "25" {
		t.Fatalf("reservation input = %#v", fake.updateInputs)
	}
	if got := aws.StringValue(fake.updateInputs[0].UpdateExpression); !strings.Contains(got, "#limit = if_not_exists(#limit, :limit)") {
		t.Fatalf("reservation must preserve an existing overage-adjusted limit: %s", got)
	}

	refundAccountQuota(quota)
	if len(fake.updateInputs) != 2 || aws.StringValue(fake.updateInputs[1].ExpressionAttributeValues[":minusOne"].N) != "-1" {
		t.Fatalf("refund input = %#v", fake.updateInputs)
	}
}

func TestAccountQuotaReservationRejectsExhaustedPlan(t *testing.T) {
	previousClient := ddbClient
	t.Cleanup(func() { ddbClient = previousClient })
	ddbClient = &fakeDynamoDB{updateErr: awserr.New(dynamodb.ErrCodeConditionalCheckFailedException, "quota exhausted", nil)}

	_, err := reserveAccountQuota("customer-123", "", time.Now())
	if !errors.Is(err, errAccountQuotaExceeded) {
		t.Fatalf("error = %v, want account quota exceeded", err)
	}
}

func TestMarkdownDocumentQuotaFailureUsesStandardResponse(t *testing.T) {
	previousClient, previousTable := ddbClient, tableName
	t.Cleanup(func() { ddbClient, tableName = previousClient, previousTable })
	ddbClient = &fakeDynamoDB{updateErr: awserr.New(dynamodb.ErrCodeConditionalCheckFailedException, "quota exhausted", nil)}
	tableName = "renderpdf-usage"

	response, err := handler(context.Background(), events.APIGatewayProxyRequest{
		Resource:   renderResource,
		Path:       renderResource,
		HTTPMethod: "POST",
		Body:       `{"version":"1","source":{"type":"markdown","content":"# {{title}}"},"data":{"title":"Report"}}`,
		RequestContext: events.APIGatewayProxyRequestContext{
			Authorizer: map[string]interface{}{"userId": "customer-123"},
		},
	})
	if err != nil {
		t.Fatalf("handle Markdown quota failure: %v", err)
	}
	if response.StatusCode != 429 {
		t.Fatalf("status = %d, want 429", response.StatusCode)
	}
	var body APIErrorResponse
	if err := json.Unmarshal([]byte(response.Body), &body); err != nil {
		t.Fatalf("decode quota response: %v", err)
	}
	if body.Code != "rate_limited" || body.RequestID == "" {
		t.Fatalf("quota response = %#v", body)
	}
}

func TestAccountQuotaReservationUpgradesExhaustedPlan(t *testing.T) {
	previousClient, previousTable := ddbClient, tableName
	t.Cleanup(func() {
		ddbClient, tableName = previousClient, previousTable
	})
	t.Setenv("FREE_MONTHLY_QUOTA", "25")
	t.Setenv("STARTER_MONTHLY_QUOTA", "5000")

	occupied := awserr.New(dynamodb.ErrCodeConditionalCheckFailedException, "free quota exhausted", nil)
	fake := &fakeDynamoDB{
		updateErrors: []error{occupied, nil},
	}
	ddbClient, tableName = fake, "renderpdf-usage"
	now := time.Date(2026, time.August, 19, 10, 0, 0, 0, time.UTC)

	quota, err := reserveAccountQuota("customer-123", "", now)
	if err != nil {
		t.Fatalf("reserve account quota should succeed after upgrade fallback: %v", err)
	}
	if quota == nil || quota.Key != "USER_QUOTA#customer-123#2026-08" {
		t.Fatalf("quota = %#v", quota)
	}
	if len(fake.updateInputs) != 2 {
		t.Fatalf("expected 2 update attempts, got %d", len(fake.updateInputs))
	}
	upgradeInput := fake.updateInputs[1]
	if got := aws.StringValue(upgradeInput.UpdateExpression); !strings.Contains(got, "#limit = :limit") {
		t.Fatalf("upgrade expression should set #limit = :limit, got %s", got)
	}
	if got := aws.StringValue(upgradeInput.ConditionExpression); !strings.Contains(got, "#limit < :limit AND #used < :limit") {
		t.Fatalf("upgrade condition should check #limit < :limit AND #used < :limit, got %s", got)
	}
}
