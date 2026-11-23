package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/target"
	"github.com/chromedp/chromedp"
)

func TestWaitForOptionsNormalizationAndDefaults(t *testing.T) {
	// 1. Default fonts is true when nothing is set
	emptyOpts := documentRenderOptions{}
	if !emptyOpts.getWaitForFonts() {
		t.Fatal("expected default waitForFonts to be true")
	}
	if emptyOpts.getWaitForSelector() != "" {
		t.Fatal("expected default waitForSelector to be empty")
	}
	if emptyOpts.getWaitForFunction() != "" {
		t.Fatal("expected default waitForFunction to be empty")
	}
	if emptyOpts.getNetworkIdle() != "" {
		t.Fatal("expected default networkIdle to be empty")
	}
	if emptyOpts.getTimeoutMs() != 0 {
		t.Fatal("expected default timeoutMs to be 0")
	}
	if !emptyOpts.isZero() {
		t.Fatal("expected empty options to be zero")
	}

	// 2. Nested waitFor takes precedence or populates
	fontsFalse := false
	nestedOpts := documentRenderOptions{
		WaitFor: &waitForOptions{
			Selector:    "#chart svg",
			Function:    "window.READY === true",
			TimeoutMs:   4000,
			NetworkIdle: "networkidle0",
			Fonts:       &fontsFalse,
		},
	}
	if nestedOpts.isZero() {
		t.Fatal("expected nested options not to be zero")
	}
	if nestedOpts.getWaitForSelector() != "#chart svg" {
		t.Fatalf("selector = %q, want #chart svg", nestedOpts.getWaitForSelector())
	}
	if nestedOpts.getWaitForFunction() != "window.READY === true" {
		t.Fatalf("function = %q", nestedOpts.getWaitForFunction())
	}
	if nestedOpts.getTimeoutMs() != 4000 {
		t.Fatalf("timeoutMs = %d, want 4000", nestedOpts.getTimeoutMs())
	}
	if nestedOpts.getNetworkIdle() != "networkidle0" {
		t.Fatalf("networkIdle = %q, want networkidle0", nestedOpts.getNetworkIdle())
	}
	if nestedOpts.getWaitForFonts() != false {
		t.Fatal("expected waitForFonts to be false when explicitly disabled")
	}

	// 3. Flat fields work as well
	fontsTrue := true
	flatOpts := documentRenderOptions{
		WaitForSelector: "#table",
		WaitForFunction: "window.STATUS === 'done'",
		TimeoutMs:       5000,
		NetworkIdle:     "networkidle2",
		WaitForFonts:    &fontsTrue,
	}
	if flatOpts.getWaitForSelector() != "#table" || flatOpts.getWaitForFunction() != "window.STATUS === 'done'" {
		t.Fatalf("flat options unexpected: %#v", flatOpts)
	}
	if flatOpts.getTimeoutMs() != 5000 || flatOpts.getNetworkIdle() != "networkidle2" || !flatOpts.getWaitForFonts() {
		t.Fatalf("flat options unexpected: %#v", flatOpts)
	}
}

func TestValidateDocumentOptionsWaitFor(t *testing.T) {
	// Valid options
	validOpts := documentRenderOptions{
		WaitFor: &waitForOptions{
			Selector:    "#analytics-chart svg",
			Function:    "window.RENDER_READY === true",
			TimeoutMs:   5000,
			NetworkIdle: "networkidle0",
		},
	}
	if err := validateDocumentOptions(&validOpts); err != nil {
		t.Fatalf("validateDocumentOptions() error = %v", err)
	}

	// Invalid networkIdle
	invalidIdle := documentRenderOptions{
		WaitFor: &waitForOptions{
			NetworkIdle: "networkidle1",
		},
	}
	if err := validateDocumentOptions(&invalidIdle); err == nil {
		t.Fatal("expected error for invalid networkIdle mode")
	}

	// Negative timeout
	negTimeout := documentRenderOptions{
		WaitFor: &waitForOptions{
			TimeoutMs: -50,
		},
	}
	if err := validateDocumentOptions(&negTimeout); err == nil {
		t.Fatal("expected error for negative timeoutMs")
	}

	// Excessive timeout
	excessiveTimeout := documentRenderOptions{
		WaitFor: &waitForOptions{
			TimeoutMs: 30000,
		},
	}
	if err := validateDocumentOptions(&excessiveTimeout); err == nil {
		t.Fatal("expected error for timeoutMs > 20000")
	}
}

func TestDocumentModeDisallowsWaitForFunction(t *testing.T) {
	body := `{
		"version":"1",
		"html":"<p>Hello {{name}}</p>",
		"data":{"name":"World"},
		"options":{
			"waitFor":{
				"function":"window.RENDER_READY === true"
			}
		}
	}`
	_, err := parseDocumentRenderRequest(body)
	if err == nil {
		t.Fatal("expected parseDocumentRenderRequest to disallow waitForFunction")
	}
	var rErr *renderError
	if ok := errorsAsRenderError(err, &rErr); !ok || rErr.Code != "document_wait_function_disallowed" {
		t.Fatalf("expected document_wait_function_disallowed error, got: %v", err)
	}
}

func errorsAsRenderError(err error, target **renderError) bool {
	if re, ok := err.(*renderError); ok {
		*target = re
		return true
	}
	return false
}

func TestCanonicalRenderRequestURLWithWaitFor(t *testing.T) {
	body := `{
		"source": { "type": "url", "url": "https://dashboard.internal/reports/123" },
		"options": {
			"waitFor": {
				"selector": "#analytics-chart svg",
				"timeoutMs": 5000
			}
		}
	}`
	normalized, err := normalizeRenderRequest(context.Background(), events.APIGatewayProxyRequest{
		Resource: renderResource,
		Body:     body,
	}, "customer-test")
	if err != nil {
		t.Fatalf("normalizeRenderRequest() error = %v", err)
	}
	if normalized.Kind != renderKindURL {
		t.Fatalf("normalized.Kind = %s, want %s", normalized.Kind, renderKindURL)
	}
	var req URLRequest
	if err := json.Unmarshal([]byte(normalized.Body), &req); err != nil {
		t.Fatalf("json.Unmarshal(URLRequest) error = %v", err)
	}
	if req.URL != "https://dashboard.internal/reports/123" {
		t.Fatalf("req.URL = %s", req.URL)
	}
	if req.Options == nil || req.Options.getWaitForSelector() != "#analytics-chart svg" || req.Options.getTimeoutMs() != 5000 {
		t.Fatalf("req.Options = %#v", req.Options)
	}
}

func TestCanonicalRenderRequestHTMLWithWaitForFunction(t *testing.T) {
	body := `{
		"source": { "type": "html", "content": "<div id=\"chart\"></div><script>window.RENDER_READY = true;</script>" },
		"options": {
			"waitFor": {
				"function": "window.RENDER_READY === true",
				"timeoutMs": 4000
			}
		}
	}`
	normalized, err := normalizeRenderRequest(context.Background(), events.APIGatewayProxyRequest{
		Resource: renderResource,
		Body:     body,
	}, "customer-test")
	if err != nil {
		t.Fatalf("normalizeRenderRequest() error = %v", err)
	}
	if normalized.Kind != renderKindHTML {
		t.Fatalf("normalized.Kind = %s, want %s", normalized.Kind, renderKindHTML)
	}
	var req Request
	if err := json.Unmarshal([]byte(normalized.Body), &req); err != nil {
		t.Fatalf("json.Unmarshal(Request) error = %v", err)
	}
	if req.Options == nil || req.Options.getWaitForFunction() != "window.RENDER_READY === true" || req.Options.getTimeoutMs() != 4000 {
		t.Fatalf("req.Options = %#v", req.Options)
	}
}

func TestNetworkIdleTracker(t *testing.T) {
	tracker := newNetworkIdleTracker()
	if tracker.activeCount() != 0 {
		t.Fatalf("initial count = %d, want 0", tracker.activeCount())
	}

	req1 := network.RequestID("req-1")
	req2 := network.RequestID("req-2")

	tracker.listen(&network.EventRequestWillBeSent{RequestID: req1})
	if tracker.activeCount() != 1 {
		t.Fatalf("count = %d, want 1", tracker.activeCount())
	}

	tracker.listen(&network.EventRequestWillBeSent{RequestID: req2})
	if tracker.activeCount() != 2 {
		t.Fatalf("count = %d, want 2", tracker.activeCount())
	}

	tracker.listen(&network.EventLoadingFinished{RequestID: req1})
	if tracker.activeCount() != 1 {
		t.Fatalf("count = %d, want 1", tracker.activeCount())
	}

	// For maxInflight = 1, it should resolve idle
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	err := tracker.waitForIdle(ctx, 1, 30*time.Millisecond)
	if err != nil {
		t.Fatalf("waitForIdle(1) error = %v", err)
	}

	// For maxInflight = 0, with req2 still active, it should timeout
	ctxTimeout, cancelTimeout := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancelTimeout()
	err = tracker.waitForIdle(ctxTimeout, 0, 30*time.Millisecond)
	if err == nil {
		t.Fatal("expected timeout when activeCount > maxInflight")
	}

	// Finish req2
	tracker.listen(&network.EventLoadingFinished{RequestID: req2})
	if tracker.activeCount() != 0 {
		t.Fatalf("count = %d, want 0", tracker.activeCount())
	}

	ctx0, cancel0 := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel0()
	err = tracker.waitForIdle(ctx0, 0, 30*time.Millisecond)
	if err != nil {
		t.Fatalf("waitForIdle(0) error = %v", err)
	}
}

func TestWaitForOptionsFullConfiguration(t *testing.T) {
	body := `{
		"source": { "type": "url", "url": "https://example.com/dashboard" },
		"options": {
			"waitFor": {
				"selector": "#chart canvas",
				"function": "() => window.CHART_READY === true",
				"networkIdle": "networkidle0",
				"timeoutMs": 6000,
				"fonts": true
			}
		}
	}`
	normalized, err := normalizeRenderRequest(context.Background(), events.APIGatewayProxyRequest{
		Resource: renderResource,
		Body:     body,
	}, "customer-test")
	if err != nil {
		t.Fatalf("normalizeRenderRequest() error = %v", err)
	}
	var req URLRequest
	if err := json.Unmarshal([]byte(normalized.Body), &req); err != nil {
		t.Fatalf("json.Unmarshal(URLRequest) error = %v", err)
	}
	if req.Options == nil {
		t.Fatal("expected req.Options to be non-nil")
	}
	if req.Options.getWaitForSelector() != "#chart canvas" {
		t.Fatalf("selector = %q", req.Options.getWaitForSelector())
	}
	if req.Options.getWaitForFunction() != "() => window.CHART_READY === true" {
		t.Fatalf("function = %q", req.Options.getWaitForFunction())
	}
	if req.Options.getNetworkIdle() != "networkidle0" {
		t.Fatalf("networkIdle = %q", req.Options.getNetworkIdle())
	}
	if req.Options.getTimeoutMs() != 6000 {
		t.Fatalf("timeoutMs = %d", req.Options.getTimeoutMs())
	}
	if !req.Options.getWaitForFonts() {
		t.Fatal("expected waitForFonts to be true")
	}
}

func TestHasExplicitWaitForTrigger(t *testing.T) {
	fontsTrue := true
	tests := []struct {
		name string
		opts documentRenderOptions
		want bool
	}{
		{name: "empty defaults", opts: documentRenderOptions{}, want: false},
		{name: "fonts only true", opts: documentRenderOptions{WaitForFonts: &fontsTrue}, want: false},
		{name: "nested fonts only", opts: documentRenderOptions{WaitFor: &waitForOptions{Fonts: &fontsTrue, TimeoutMs: 5000}}, want: false},
		{name: "flat selector", opts: documentRenderOptions{WaitForSelector: "#ready"}, want: true},
		{name: "nested selector", opts: documentRenderOptions{WaitFor: &waitForOptions{Selector: "#ready"}}, want: true},
		{name: "flat function", opts: documentRenderOptions{WaitForFunction: "() => true"}, want: true},
		{name: "nested function", opts: documentRenderOptions{WaitFor: &waitForOptions{Function: "() => true"}}, want: true},
		{name: "networkidle0", opts: documentRenderOptions{WaitFor: &waitForOptions{NetworkIdle: "networkidle0"}}, want: true},
		{name: "networkidle2 uppercase", opts: documentRenderOptions{NetworkIdle: "NETWORKIDLE2"}, want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.opts.hasExplicitWaitForTrigger(); got != tt.want {
				t.Fatalf("hasExplicitWaitForTrigger() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestCdpExecutorContext(t *testing.T) {
	plainExec := cdpExecutorContext(context.Background())
	if err := cdp.Execute(plainExec, target.CommandCloseTarget, nil, nil); !errors.Is(err, cdp.ErrInvalidContext) {
		t.Fatalf("expected cdp.ErrInvalidContext for plain context, got: %v", err)
	}

	taskCtx, cancel := chromedp.NewContext(context.Background())
	defer cancel()

	noTargetExec := cdpExecutorContext(taskCtx)
	if err := cdp.Execute(noTargetExec, target.CommandCloseTarget, nil, nil); !errors.Is(err, cdp.ErrInvalidContext) {
		t.Fatalf("expected cdp.ErrInvalidContext when chromedp Target is nil, got: %v", err)
	}

	c := chromedp.FromContext(taskCtx)
	c.Target = &chromedp.Target{}

	// Raw taskCtx lacks a cdp.Executor, which previously caused EventRequestPaused handlers to fail silently.
	if err := cdp.Execute(taskCtx, target.CommandCloseTarget, nil, nil); !errors.Is(err, cdp.ErrInvalidContext) {
		t.Fatalf("expected cdp.ErrInvalidContext on raw taskCtx, got: %v", err)
	}

	execCtx := cdpExecutorContext(taskCtx)
	if got := cdp.ExecutorFromContext(execCtx); got != c.Target {
		t.Fatalf("ExecutorFromContext() = %v, want %v", got, c.Target)
	}
	err := cdp.Execute(execCtx, target.CommandCloseTarget, nil, nil)
	if err == nil || errors.Is(err, cdp.ErrInvalidContext) {
		t.Fatalf("expected Target.Execute response instead of ErrInvalidContext, got: %v", err)
	}
}
