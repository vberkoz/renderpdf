package main

import (
	"context"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/log"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/runtime"
)

const maxDiagnosticItems = 10

type renderWarning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	URL     string `json:"url,omitempty"`
}

type diagnosticsContextKey struct{}

func withRenderDiagnostics(ctx context.Context, d *renderDiagnostics) context.Context {
	if ctx == nil || d == nil {
		return ctx
	}
	return context.WithValue(ctx, diagnosticsContextKey{}, d)
}

func renderDiagnosticsFromContext(ctx context.Context) *renderDiagnostics {
	if ctx == nil {
		return nil
	}
	if d, ok := ctx.Value(diagnosticsContextKey{}).(*renderDiagnostics); ok && d != nil {
		return d
	}
	return nil
}

type renderDiagnostics struct {
	mu           sync.Mutex
	imageFail    bool
	jsFail       bool
	cssFail      bool
	ssrfURLs     []string
	failedAssets []string
	jsErrors     []string
	cssErrors    []string
	requestURLs  map[network.RequestID]string
}

func newRenderDiagnostics() *renderDiagnostics {
	return &renderDiagnostics{
		requestURLs: make(map[network.RequestID]string),
	}
}

func sanitizeDiagnosticURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.HasPrefix(strings.ToLower(trimmed), "data:") {
		return ""
	}
	if parsed, err := url.Parse(trimmed); err == nil && parsed.Scheme != "" {
		parsed.User = nil
		parsed.RawQuery = ""
		parsed.Fragment = ""
		trimmed = parsed.String()
	}
	if len(trimmed) > 256 {
		return trimmed[:256] + "..."
	}
	return trimmed
}

func truncateDiagnosticText(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) > 256 {
		return trimmed[:256] + "..."
	}
	return trimmed
}

func appendBoundedUnique(slice []string, value string) []string {
	if value == "" || len(slice) >= maxDiagnosticItems {
		return slice
	}
	for _, existing := range slice {
		if existing == value {
			return slice
		}
	}
	return append(slice, value)
}

func (d *renderDiagnostics) recordSSRFBlocked(rawURL string) {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ssrfURLs = appendBoundedUnique(d.ssrfURLs, sanitizeDiagnosticURL(rawURL))
}

func (d *renderDiagnostics) listen(event interface{}) {
	d.mu.Lock()
	defer d.mu.Unlock()

	switch event := event.(type) {
	case *network.EventRequestWillBeSent:
		if event.Request != nil {
			if clean := sanitizeDiagnosticURL(event.Request.URL); clean != "" {
				if d.requestURLs == nil {
					d.requestURLs = make(map[network.RequestID]string)
				}
				d.requestURLs[event.RequestID] = clean
			}
		}
	case *network.EventLoadingFailed:
		if event.Type == network.ResourceTypeImage && !event.Canceled {
			d.imageFail = true
			if d.requestURLs != nil {
				if reqURL := d.requestURLs[event.RequestID]; reqURL != "" {
					d.failedAssets = appendBoundedUnique(d.failedAssets, reqURL)
				}
			}
		}
	case *runtime.EventExceptionThrown:
		d.jsFail = true
		if event.ExceptionDetails != nil {
			msg := truncateDiagnosticText(event.ExceptionDetails.Text)
			if event.ExceptionDetails.Exception != nil && strings.TrimSpace(event.ExceptionDetails.Exception.Description) != "" {
				msg = truncateDiagnosticText(event.ExceptionDetails.Exception.Description)
			}
			d.jsErrors = appendBoundedUnique(d.jsErrors, msg)
		}
	case *log.EventEntryAdded:
		if event.Entry == nil {
			return
		}
		text := strings.ToLower(event.Entry.Text)
		if strings.Contains(text, "css") && (strings.Contains(text, "parse") || strings.Contains(text, "syntax") || strings.Contains(text, "stylesheet")) {
			d.cssFail = true
			d.cssErrors = appendBoundedUnique(d.cssErrors, truncateDiagnosticText(event.Entry.Text))
		}
	}
}

func (d *renderDiagnostics) detailsLocked() map[string]any {
	details := make(map[string]any)
	if len(d.ssrfURLs) > 0 {
		details["ssrfBlockedUrls"] = append([]string(nil), d.ssrfURLs...)
	}
	if len(d.failedAssets) > 0 {
		details["failedAssetUrls"] = append([]string(nil), d.failedAssets...)
	}
	if len(d.jsErrors) > 0 {
		details["jsErrors"] = append([]string(nil), d.jsErrors...)
	}
	if len(d.cssErrors) > 0 {
		details["cssErrors"] = append([]string(nil), d.cssErrors...)
	}
	if len(details) == 0 {
		return nil
	}
	return details
}

func (d *renderDiagnostics) details() map[string]any {
	if d == nil {
		return nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.detailsLocked()
}

func (d *renderDiagnostics) warnings() []renderWarning {
	if d == nil {
		return nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()

	var warnings []renderWarning
	for _, u := range d.ssrfURLs {
		warnings = append(warnings, renderWarning{
			Code:    "ssrf_blocked",
			Message: "Blocked subresource request to disallowed or non-public URL",
			URL:     u,
		})
	}
	if len(d.failedAssets) > 0 {
		for _, u := range d.failedAssets {
			warnings = append(warnings, renderWarning{
				Code:    "image_loading_failed",
				Message: "An image failed to load while rendering the page",
				URL:     u,
			})
		}
	} else if d.imageFail {
		warnings = append(warnings, renderWarning{
			Code:    "image_loading_failed",
			Message: "An image failed to load while rendering the page",
		})
	}
	if len(d.jsErrors) > 0 {
		for _, msg := range d.jsErrors {
			warnings = append(warnings, renderWarning{
				Code:    "javascript_exception",
				Message: msg,
			})
		}
	} else if d.jsFail {
		warnings = append(warnings, renderWarning{
			Code:    "javascript_exception",
			Message: "JavaScript exception while rendering the page",
		})
	}
	if len(d.cssErrors) > 0 {
		for _, msg := range d.cssErrors {
			warnings = append(warnings, renderWarning{
				Code:    "css_parsing_error",
				Message: msg,
			})
		}
	} else if d.cssFail {
		warnings = append(warnings, renderWarning{
			Code:    "css_parsing_error",
			Message: "CSS parsing error while rendering the page",
		})
	}
	return warnings
}

func (d *renderDiagnostics) error() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	details := d.detailsLocked()
	// Prefer direct document failures over asset failures, so a page with both
	// reports the most actionable cause first.
	if d.jsFail {
		return &renderError{Code: "javascript_exception", Message: "JavaScript exception while rendering the page", Details: details}
	}
	if d.cssFail {
		return &renderError{Code: "css_parsing_error", Message: "CSS parsing error while rendering the page", Details: details}
	}
	if d.imageFail {
		return &renderError{Code: "image_loading_failed", Message: "An image failed to load while rendering the page", Details: details}
	}
	return nil
}

// networkIdleTracker tracks in-flight HTTP requests over CDP to determine
// when network activity has ceased for a specified duration (networkidle0/networkidle2).
type networkIdleTracker struct {
	mu       sync.Mutex
	inflight map[network.RequestID]struct{}
	notify   chan struct{}
}

func newNetworkIdleTracker() *networkIdleTracker {
	return &networkIdleTracker{
		inflight: make(map[network.RequestID]struct{}),
		notify:   make(chan struct{}, 100),
	}
}

func (t *networkIdleTracker) listen(ev interface{}) {
	t.mu.Lock()
	defer t.mu.Unlock()

	switch event := ev.(type) {
	case *network.EventRequestWillBeSent:
		t.inflight[event.RequestID] = struct{}{}
		t.broadcast()
	case *network.EventLoadingFinished:
		delete(t.inflight, event.RequestID)
		t.broadcast()
	case *network.EventLoadingFailed:
		delete(t.inflight, event.RequestID)
		t.broadcast()
	}
}

func (t *networkIdleTracker) broadcast() {
	select {
	case t.notify <- struct{}{}:
	default:
	}
}

func (t *networkIdleTracker) activeCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.inflight)
}

func (t *networkIdleTracker) waitForIdle(ctx context.Context, maxInflight int, idleDuration time.Duration) error {
	timer := time.NewTimer(idleDuration)
	defer timer.Stop()

	if t.activeCount() > maxInflight {
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			if t.activeCount() <= maxInflight {
				return nil
			}
		case <-t.notify:
			if t.activeCount() <= maxInflight {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(idleDuration)
			} else {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
			}
		}
	}
}
