package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/service/sqs"
)

type fakeSQS struct {
	input *sqs.SendMessageInput
}

func (fake *fakeSQS) SendMessageWithContext(_ aws.Context, input *sqs.SendMessageInput, _ ...request.Option) (*sqs.SendMessageOutput, error) {
	fake.input = input
	return &sqs.SendMessageOutput{}, nil
}

func TestValidateWebhookURL(t *testing.T) {
	valid, err := validateWebhookURL("https://8.8.8.8/hooks/pdf")
	if err != nil || valid != "https://8.8.8.8/hooks/pdf" {
		t.Fatalf("expected public HTTPS URL to be valid, got %q, %v", valid, err)
	}

	for _, raw := range []string{
		"http://example.com/hook",
		"https://localhost/hook",
		"https://127.0.0.1/hook",
		"https://169.254.169.254/latest/meta-data",
		"https://user:password@example.com/hook",
		"https://example.com:8443/hook",
	} {
		if _, err := validateWebhookURL(raw); err == nil {
			t.Errorf("expected %q to be rejected", raw)
		}
	}
}

func TestEnqueueWebhookCreatesDocumentCompletionRequest(t *testing.T) {
	previousClient := sqsClient
	t.Cleanup(func() { sqsClient = previousClient })
	fake := &fakeSQS{}
	sqsClient = fake
	t.Setenv("WEBHOOK_QUEUE_URL", "https://sqs.us-east-1.amazonaws.com/123/renderpdf-webhooks")

	event := webhookEvent{
		ID: "request-123", URL: "https://example.test/hooks/pdf", Secret: "signing-secret",
		PDFURL: "https://bucket.example.test/request-123.pdf", PDFSize: 2048,
		CreatedAt: time.Date(2026, time.August, 19, 10, 0, 0, 0, time.UTC),
	}
	if err := enqueueWebhook(context.Background(), event); err != nil {
		t.Fatalf("enqueue webhook: %v", err)
	}
	if fake.input == nil || aws.StringValue(fake.input.QueueUrl) == "" {
		t.Fatal("expected an SQS webhook request")
	}
	var queued webhookEvent
	if err := json.Unmarshal([]byte(aws.StringValue(fake.input.MessageBody)), &queued); err != nil {
		t.Fatalf("decode queued webhook: %v", err)
	}
	if queued.ID != event.ID || queued.URL != event.URL || queued.Secret != event.Secret || queued.PDFURL != event.PDFURL || queued.PDFSize != event.PDFSize {
		t.Fatalf("queued webhook = %#v, want %#v", queued, event)
	}
}
