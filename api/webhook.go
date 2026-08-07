package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/service/sqs"
)

// webhookEvent contains no customer HTML or API credentials. The optional
// secret is encrypted at rest by SQS and is used only to sign the delivery.
type webhookEvent struct {
	ID        string    `json:"id"`
	URL       string    `json:"url"`
	Secret    string    `json:"secret,omitempty"`
	PDFURL    string    `json:"pdfUrl"`
	PDFSize   int64     `json:"pdfSize"`
	CreatedAt time.Time `json:"createdAt"`
}

// validateWebhookURL intentionally accepts only HTTPS public endpoints. This
// keeps a render request from being used to reach private AWS or local hosts.
func validateWebhookURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed == nil || parsed.Host == "" || parsed.Scheme != "https" {
		return "", fmt.Errorf("webhookUrl must be a valid absolute HTTPS URL")
	}
	if parsed.User != nil || (parsed.Port() != "" && parsed.Port() != "443") {
		return "", fmt.Errorf("webhookUrl must not contain credentials and must use port 443")
	}
	host := parsed.Hostname()
	if host == "" || strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return "", fmt.Errorf("webhookUrl must target a public host")
	}
	addresses := []net.IP{net.ParseIP(host)}
	if addresses[0] == nil {
		addresses, err = net.LookupIP(host)
		if err != nil || len(addresses) == 0 {
			return "", fmt.Errorf("webhookUrl host could not be resolved")
		}
	}
	for _, address := range addresses {
		if !isPublicIP(address) {
			return "", fmt.Errorf("webhookUrl must target a public host")
		}
	}
	return parsed.String(), nil
}

func enqueueWebhook(ctx context.Context, event webhookEvent) error {
	queueURL := os.Getenv("WEBHOOK_QUEUE_URL")
	if queueURL == "" {
		return fmt.Errorf("WEBHOOK_QUEUE_URL is not configured")
	}
	body, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = sqsClient.SendMessageWithContext(ctx, &sqs.SendMessageInput{
		QueueUrl:    aws.String(queueURL),
		MessageBody: aws.String(string(body)),
	})
	return err
}
