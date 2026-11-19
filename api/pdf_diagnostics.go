package main

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/log"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/runtime"
)

type renderDiagnostics struct {
	mu        sync.Mutex
	imageFail bool
	jsFail    bool
	cssFail   bool
}

func newRenderDiagnostics() *renderDiagnostics { return &renderDiagnostics{} }

func (d *renderDiagnostics) listen(event interface{}) {
	d.mu.Lock()
	defer d.mu.Unlock()

	switch event := event.(type) {
	case *network.EventLoadingFailed:
		if event.Type == network.ResourceTypeImage && !event.Canceled {
			d.imageFail = true
		}
	case *runtime.EventExceptionThrown:
		d.jsFail = true
	case *log.EventEntryAdded:
		if event.Entry == nil {
			return
		}
		text := strings.ToLower(event.Entry.Text)
		if strings.Contains(text, "css") && (strings.Contains(text, "parse") || strings.Contains(text, "syntax") || strings.Contains(text, "stylesheet")) {
			d.cssFail = true
		}
	}
}

func (d *renderDiagnostics) error() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Prefer direct document failures over asset failures, so a page with both
	// reports the most actionable cause first.
	if d.jsFail {
		return &renderError{Code: "javascript_exception", Message: "JavaScript exception while rendering the page"}
	}
	if d.cssFail {
		return &renderError{Code: "css_parsing_error", Message: "CSS parsing error while rendering the page"}
	}
	if d.imageFail {
		return &renderError{Code: "image_loading_failed", Message: "An image failed to load while rendering the page"}
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
