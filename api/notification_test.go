package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/ses"
)

type mockSESClient struct {
	sentInputs []*ses.SendEmailInput
	sendErr    error
}

func (m *mockSESClient) SendEmailWithContext(ctx aws.Context, input *ses.SendEmailInput, opts ...request.Option) (*ses.SendEmailOutput, error) {
	m.sentInputs = append(m.sentInputs, input)
	if m.sendErr != nil {
		return nil, m.sendErr
	}
	messageID := "msg-12345"
	return &ses.SendEmailOutput{MessageId: &messageID}, nil
}

func TestBuildQuota80Email(t *testing.T) {
	subj, html, text := buildQuota80Email(4000, 5000)

	if !strings.Contains(subj, "80%") {
		t.Fatalf("expected subject to contain 80%%, got: %s", subj)
	}

	expectedPhrase := "You've used 80% of your monthly RenderPDF allowance. Upgrade to avoid API disruptions."
	if !strings.Contains(text, expectedPhrase) {
		t.Fatalf("expected text to contain exact phrase %q, got: %s", expectedPhrase, text)
	}
	if !strings.Contains(html, expectedPhrase) {
		t.Fatalf("expected html to contain exact phrase %q, got: %s", expectedPhrase, html)
	}

	expectedLink := "https://renderpdf.vberkoz.com/app/#billing"
	if !strings.Contains(text, expectedLink) {
		t.Fatalf("expected text to contain billing link %q, got: %s", expectedLink, text)
	}
	if !strings.Contains(html, expectedLink) {
		t.Fatalf("expected html to contain billing link %q, got: %s", expectedLink, html)
	}
}

func TestBuildQuota100Email(t *testing.T) {
	subj, html, text := buildQuota100Email(5000, 5000)

	if !strings.Contains(subj, "100%") {
		t.Fatalf("expected subject to contain 100%%, got: %s", subj)
	}

	if !strings.Contains(text, "Purchase 1,000 PDF overage") {
		t.Fatalf("expected text to mention quick link to purchase 1,000 PDF overage, got: %s", text)
	}
	if !strings.Contains(text, "Upgrade tier") {
		t.Fatalf("expected text to mention quick link to upgrade tier, got: %s", text)
	}

	expectedLink := "https://renderpdf.vberkoz.com/app/#billing"
	if !strings.Contains(html, expectedLink) {
		t.Fatalf("expected html to contain quick link %q, got: %s", expectedLink, html)
	}
	if !strings.Contains(html, "Purchase 1,000 PDF Overage") {
		t.Fatalf("expected html to contain button for 1,000 PDF overage, got: %s", html)
	}
	if !strings.Contains(html, "Upgrade Tier") {
		t.Fatalf("expected html to contain button for upgrading tier, got: %s", html)
	}
}

func TestClaimQuota80AlertDeduplication(t *testing.T) {
	fake := &fakeDynamoDB{}
	prevClient, prevTable := ddbClient, tableName
	ddbClient, tableName = fake, "renderpdf-usage"
	t.Cleanup(func() { ddbClient, tableName = prevClient, prevTable })

	now := time.Date(2026, time.September, 19, 12, 0, 0, 0, time.UTC)
	key := "USER_QUOTA#user-123#2026-09"

	// First claim succeeds
	claimed, err := claimQuota80Alert(key, now)
	if err != nil || !claimed {
		t.Fatalf("first claim failed: claimed=%v, err=%v", claimed, err)
	}
	if len(fake.updateInputs) != 1 {
		t.Fatalf("expected 1 update input, got %d", len(fake.updateInputs))
	}
	if aws.StringValue(fake.updateInputs[0].ConditionExpression) != "attribute_not_exists(alert80SentAt)" {
		t.Fatalf("expected condition attribute_not_exists(alert80SentAt), got %s", aws.StringValue(fake.updateInputs[0].ConditionExpression))
	}

	// Second claim triggers conditional check failure (already sent)
	fake.updateErr = awserr.New(dynamodb.ErrCodeConditionalCheckFailedException, "already sent", nil)
	claimedAgain, err := claimQuota80Alert(key, now)
	if err != nil {
		t.Fatalf("expected nil error on duplicate claim, got: %v", err)
	}
	if claimedAgain {
		t.Fatalf("expected claimedAgain to be false, got true")
	}
}

func TestClaimQuota100AlertDeduplicationAndOverageReAlert(t *testing.T) {
	fake := &fakeDynamoDB{}
	prevClient, prevTable := ddbClient, tableName
	ddbClient, tableName = fake, "renderpdf-usage"
	t.Cleanup(func() { ddbClient, tableName = prevClient, prevTable })

	now := time.Date(2026, time.September, 19, 12, 0, 0, 0, time.UTC)
	key := "USER_QUOTA#user-123#2026-09"

	// First claim at 5,000 limit succeeds
	claimed, err := claimQuota100Alert(key, 5000, now)
	if err != nil || !claimed {
		t.Fatalf("first claim at 5000 failed: claimed=%v, err=%v", claimed, err)
	}
	if aws.StringValue(fake.updateInputs[0].ConditionExpression) != "attribute_not_exists(alert100SentLimit) OR alert100SentLimit < :limit" {
		t.Fatalf("unexpected condition: %s", aws.StringValue(fake.updateInputs[0].ConditionExpression))
	}

	// Repeated check at 5,000 fails (deduplicated)
	fake.updateErr = awserr.New(dynamodb.ErrCodeConditionalCheckFailedException, "already sent for 5000", nil)
	claimedAgain, err := claimQuota100Alert(key, 5000, now)
	if err != nil || claimedAgain {
		t.Fatalf("expected false on repeated 5000 claim: claimed=%v, err=%v", claimedAgain, err)
	}

	// After purchasing overage, limit is now 6,000. Re-alerting succeeds!
	fake.updateErr = nil
	claimedOverage, err := claimQuota100Alert(key, 6000, now)
	if err != nil || !claimedOverage {
		t.Fatalf("expected true for higher limit 6000 claim: claimed=%v, err=%v", claimedOverage, err)
	}
	lastInput := fake.updateInputs[len(fake.updateInputs)-1]
	if aws.StringValue(lastInput.ExpressionAttributeValues[":limit"].N) != "6000" {
		t.Fatalf("expected limit attribute 6000, got: %s", aws.StringValue(lastInput.ExpressionAttributeValues[":limit"].N))
	}
}

func TestSendSESEmail(t *testing.T) {
	mock := &mockSESClient{}
	prevSES := sesClient
	sesClient = mock
	t.Cleanup(func() { sesClient = prevSES })

	ctx := context.Background()

	// Empty recipient fails
	if err := sendSESEmail(ctx, "", "Subject", "<h1>Hi</h1>", "Hi"); err == nil {
		t.Fatal("expected error for empty recipient email")
	}

	// Valid send succeeds
	err := sendSESEmail(ctx, "customer@example.com", "Test Subject", "<p>Hello</p>", "Hello")
	if err != nil {
		t.Fatalf("sendSESEmail failed: %v", err)
	}

	if len(mock.sentInputs) != 1 {
		t.Fatalf("expected 1 sent SES message, got %d", len(mock.sentInputs))
	}
	input := mock.sentInputs[0]
	if aws.StringValue(input.Destination.ToAddresses[0]) != "customer@example.com" {
		t.Fatalf("to address = %s, want customer@example.com", aws.StringValue(input.Destination.ToAddresses[0]))
	}
	if aws.StringValue(input.Message.Subject.Data) != "Test Subject" {
		t.Fatalf("subject = %s, want Test Subject", aws.StringValue(input.Message.Subject.Data))
	}
	if aws.StringValue(input.Message.Body.Html.Data) != "<p>Hello</p>" {
		t.Fatalf("html = %s, want <p>Hello</p>", aws.StringValue(input.Message.Body.Html.Data))
	}
	if aws.StringValue(input.Message.Body.Text.Data) != "Hello" {
		t.Fatalf("text = %s, want Hello", aws.StringValue(input.Message.Body.Text.Data))
	}
}

func TestMaybeSendQuotaAlertThresholds(t *testing.T) {
	mock := &mockSESClient{}
	prevSES := sesClient
	sesClient = mock
	t.Cleanup(func() { sesClient = prevSES })

	fake := &fakeDynamoDB{}
	prevClient, prevTable := ddbClient, tableName
	ddbClient, tableName = fake, "renderpdf-usage"
	t.Cleanup(func() { ddbClient, tableName = prevClient, prevTable })

	now := time.Now().UTC()
	quotaKey := "USER_QUOTA#cust-1#2026-09"

	// 1. Below 80% (79%): no alert
	maybeSendQuotaAlert("cust-1", "user@example.com", quotaKey, 3999, 5000, now)
	if len(mock.sentInputs) != 0 {
		t.Fatalf("expected 0 emails at 79%%, got %d", len(mock.sentInputs))
	}

	// 2. Exactly 80% (4000/5000): sends 80% alert
	maybeSendQuotaAlert("cust-1", "user@example.com", quotaKey, 4000, 5000, now)
	if len(mock.sentInputs) != 1 {
		t.Fatalf("expected 1 email at 80%%, got %d", len(mock.sentInputs))
	}
	if !strings.Contains(aws.StringValue(mock.sentInputs[0].Message.Subject.Data), "80%") {
		t.Fatalf("expected 80%% alert subject, got: %s", aws.StringValue(mock.sentInputs[0].Message.Subject.Data))
	}

	// 3. Exactly 100% (5000/5000): sends 100% alert
	maybeSendQuotaAlert("cust-1", "user@example.com", quotaKey, 5000, 5000, now)
	if len(mock.sentInputs) != 2 {
		t.Fatalf("expected 2 emails after 100%%, got %d", len(mock.sentInputs))
	}
	if !strings.Contains(aws.StringValue(mock.sentInputs[1].Message.Subject.Data), "100%") {
		t.Fatalf("expected 100%% alert subject, got: %s", aws.StringValue(mock.sentInputs[1].Message.Subject.Data))
	}
}
