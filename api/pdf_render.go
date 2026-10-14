package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/fetch"
	"github.com/chromedp/cdproto/log"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

func applyPDFSecurity(pdfBytes []byte, options documentRenderOptions) ([]byte, error) {
	if options.Password == "" && options.OwnerPassword == "" {
		return pdfBytes, nil
	}
	userPW := options.Password
	ownerPW := options.OwnerPassword
	if ownerPW == "" {
		ownerPW = userPW
	}
	conf := model.NewAESConfiguration(userPW, ownerPW, 256)
	switch strings.ToLower(strings.TrimSpace(options.Permissions)) {
	case "none":
		conf.Permissions = model.PermissionsNone
	case "print":
		conf.Permissions = model.PermissionsPrint
	default:
		conf.Permissions = model.PermissionsAll
	}
	var out bytes.Buffer
	if err := api.Encrypt(bytes.NewReader(pdfBytes), &out, conf); err != nil {
		return nil, fmt.Errorf("encrypt pdf: %w", err)
	}
	return out.Bytes(), nil
}

func generatePDF(ctx context.Context, html string) ([]byte, error) {
	return generatePDFWithOptions(ctx, html, documentRenderOptions{})
}

func generatePDFWithOptions(ctx context.Context, html string, options documentRenderOptions) ([]byte, error) {
	displayHeaderFooter := true
	if options.DisplayHeaderFooter != nil {
		displayHeaderFooter = *options.DisplayHeaderFooter
	} else if strings.Contains(strings.ToLower(html), "renderpdf:no-header-footer") {
		displayHeaderFooter = false
	}
	escaped := url.PathEscape(html)
	headerTmpl := options.HeaderTemplate
	if headerTmpl == "" {
		headerTmpl = defaultHeaderTemplate
	}
	footerTmpl := options.FooterTemplate
	if footerTmpl == "" {
		footerTmpl = defaultFooterTemplate
	}
	pdfBytes, err := generatePDFURLWithCustomSettings(ctx, "data:text/html;charset=utf-8,"+escaped, displayHeaderFooter, headerTmpl, footerTmpl, false, options)
	if err != nil {
		return nil, err
	}
	return applyPDFSecurity(pdfBytes, options)
}

// generateDocumentPDF is the restricted renderer for the document JSON mode.
// Its input has already passed document safety validation, and JavaScript is
// disabled as a defense in depth measure before navigation.
func generateDocumentPDF(ctx context.Context, documentHTML string) ([]byte, error) {
	return generateDocumentPDFWithOptions(ctx, documentHTML, documentRenderOptions{})
}

func generateDocumentPDFWithOptions(ctx context.Context, documentHTML string, options documentRenderOptions) ([]byte, error) {
	displayHeaderFooter := true
	if options.DisplayHeaderFooter != nil {
		displayHeaderFooter = *options.DisplayHeaderFooter
	}
	escaped := url.PathEscape(documentHTML)
	headerTmpl := options.HeaderTemplate
	if headerTmpl == "" {
		headerTmpl = defaultHeaderTemplate
	}
	footerTmpl := options.FooterTemplate
	if footerTmpl == "" {
		footerTmpl = defaultFooterTemplate
	}
	pdfBytes, err := generatePDFURLWithCustomSettings(ctx, "data:text/html;charset=utf-8,"+escaped, displayHeaderFooter, headerTmpl, footerTmpl, true, options)
	if err != nil {
		return nil, err
	}
	return applyPDFSecurity(pdfBytes, options)
}

func generatePDFURL(ctx context.Context, targetURL string) ([]byte, error) {
	return generatePDFURLWithOptions(ctx, targetURL, true)
}

func generatePDFURLWithOptions(ctx context.Context, targetURL string, displayHeaderFooter bool) ([]byte, error) {
	return generatePDFURLWithRenderSettings(ctx, targetURL, displayHeaderFooter, false)
}

func generatePDFURLWithRenderSettings(ctx context.Context, targetURL string, displayHeaderFooter, disableJavaScript bool) ([]byte, error) {
	return generatePDFURLWithCustomSettings(ctx, targetURL, displayHeaderFooter, defaultHeaderTemplate, defaultFooterTemplate, disableJavaScript, documentRenderOptions{})
}

func generatePDFURLWithDocumentOptions(ctx context.Context, targetURL string, options documentRenderOptions) ([]byte, error) {
	displayHeaderFooter := true
	if options.DisplayHeaderFooter != nil {
		displayHeaderFooter = *options.DisplayHeaderFooter
	}
	headerTmpl := options.HeaderTemplate
	if headerTmpl == "" {
		headerTmpl = defaultHeaderTemplate
	}
	footerTmpl := options.FooterTemplate
	if footerTmpl == "" {
		footerTmpl = defaultFooterTemplate
	}
	pdfBytes, err := generatePDFURLWithCustomSettings(ctx, targetURL, displayHeaderFooter, headerTmpl, footerTmpl, false, options)
	if err != nil {
		return nil, err
	}
	return applyPDFSecurity(pdfBytes, options)
}

func generatePDFURLWithCustomSettings(ctx context.Context, targetURL string, displayHeaderFooter bool, headerTemplate, footerTemplate string, disableJavaScript bool, options documentRenderOptions) ([]byte, error) {
	// Use one deadline for the browser's entire lifetime. A launch-only child
	// context becomes Chrome's owner inside chromedp; when that shorter context
	// expires it kills an otherwise healthy browser during PDF rendering.
	generationCtx, generationCancel := context.WithTimeout(ctx, 24*time.Second)
	defer generationCancel()

	chromePath, err := prepareChrome()
	if err != nil {
		return nil, err
	}
	fmt.Printf("Using Chrome at: %s\n", chromePath)

	os.RemoveAll("/tmp/chrome-data")
	os.MkdirAll("/tmp/chrome-data", 0755)

	var browserOutput bytes.Buffer
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(chromePath),
		chromedp.CombinedOutput(&browserOutput),
		// Chrome can spend most of ten seconds faulting the browser image into
		// memory during a Lambda cold start before it prints the DevTools URL.
		// Keep this below API Gateway's synchronous timeout, but leave enough
		// headroom for the first invocation of a fresh execution environment.
		chromedp.WSURLReadTimeout(18*time.Second),
		chromedp.NoSandbox,
		chromedp.DisableGPU,
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("disable-setuid-sandbox", true),
		// Lambda's Firecracker runtime requires Chrome to avoid spawning the
		// usual browser process tree. Disable proxy resolution as well: Chrome's
		// V8 proxy resolver is not supported in single-process mode and can block
		// startup before the DevTools endpoint is published.
		chromedp.Flag("no-zygote", true),
		chromedp.Flag("single-process", true),
		chromedp.Flag("no-proxy-server", true),
		chromedp.Flag("allow-file-access-from-files", true),
		chromedp.Flag("proxy-bypass-list", "*"),
		chromedp.UserDataDir("/tmp/chrome-data"),
		chromedp.WindowSize(1920, 1080),
	)

	fmt.Println("Creating Chrome allocator...")
	allocCtx, allocCancel := chromedp.NewExecAllocator(generationCtx, opts...)
	defer allocCancel()

	fmt.Println("Creating Chrome context...")
	taskCtx, taskCancel := chromedp.NewContext(
		allocCtx,
		chromedp.WithLogf(func(format string, args ...interface{}) {
			fmt.Printf("chromedp: "+format+"\n", args...)
		}),
		chromedp.WithErrorf(func(format string, args ...interface{}) {
			fmt.Printf("chromedp ERROR: "+format+"\n", args...)
		}),
	)
	defer taskCancel()

	fmt.Println("Starting browser...")
	if err := chromedp.Run(taskCtx); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, &renderError{Code: "chromium_timeout", Message: "Chromium timed out while starting", Status: 504}
		}
		return nil, fmt.Errorf("failed to start browser: %v: %s", err, browserOutput.String())
	}
	fmt.Println("Browser started successfully")

	var buf []byte
	diagnostics := newRenderDiagnostics()
	chromedp.ListenTarget(taskCtx, diagnostics.listen)
	netTracker := newNetworkIdleTracker()
	chromedp.ListenTarget(taskCtx, netTracker.listen)
	chromedp.ListenTarget(taskCtx, func(ev interface{}) {
		event, ok := ev.(*fetch.EventRequestPaused)
		if !ok || event == nil {
			return
		}
		if event.Request == nil {
			go func(reqID fetch.RequestID) {
				if taskCtx.Err() != nil {
					return
				}
				_ = fetch.FailRequest(reqID, network.ErrorReasonBlockedByClient).Do(taskCtx)
			}(event.RequestID)
			return
		}

		reqID := event.RequestID
		reqURL := event.Request.URL
		go func() {
			if taskCtx.Err() != nil {
				return
			}
			if !isSafeNetworkURL(reqURL) {
				fmt.Printf("SSRF filter: blocked request to %s\n", reqURL)
				_ = fetch.FailRequest(reqID, network.ErrorReasonBlockedByClient).Do(taskCtx)
				return
			}
			_ = fetch.ContinueRequest(reqID).Do(taskCtx)
		}()
	})
	stage := "navigation"

	fmt.Println("Running chromedp...")
	actions := []chromedp.Action{fetch.Enable(), network.Enable(), runtime.Enable(), log.Enable()}
	if disableJavaScript {
		actions = append(actions, emulation.SetScriptExecutionDisabled(true))
	}
	actions = append(actions,
		// Do not wait for every remote asset to finish. A slow image or
		// stylesheet must not consume the API Gateway timeout before print.
		chromedp.ActionFunc(func(ctx context.Context) error {
			_, _, errorText, _, err := page.Navigate(targetURL).Do(ctx)
			if err != nil {
				if errors.Is(err, context.DeadlineExceeded) {
					return err
				}
				return &renderError{Code: "navigation_failed", Message: "Page navigation failed"}
			}
			if errorText != "" {
				return &renderError{Code: "navigation_failed", Message: "Page navigation failed"}
			}
			return nil
		}),
		chromedp.WaitReady("body"),
		chromedp.ActionFunc(func(ctx context.Context) error {
			return emulation.SetDeviceMetricsOverride(
				1920,
				1080,
				1,
				false,
			).WithScreenOrientation(
				&emulation.ScreenOrientation{
					Type:  emulation.OrientationTypePortraitPrimary,
					Angle: 0,
				},
			).Do(ctx)
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			return emulation.SetEmulatedMedia().WithMedia("print").Do(ctx)
		}),
		// 1. CSS Animation & Transition Disable: Inject a CSS rule prior to rendering
		chromedp.ActionFunc(func(ctx context.Context) error {
			if disableJavaScript {
				return nil
			}
			_, _, _ = runtime.Evaluate(`(() => {
				try {
					const style = document.createElement('style');
					style.setAttribute('data-renderpdf', 'disable-animations');
					style.textContent = '*, *::before, *::after { -webkit-transition-duration: 0s !important; transition-duration: 0s !important; -webkit-animation-duration: 0s !important; animation-duration: 0s !important; }';
					(document.head || document.documentElement).appendChild(style);
				} catch (e) {}
			})()`).Do(ctx)
			return nil
		}),
		// 2. Smart Wait-For Readiness Triggers
		chromedp.ActionFunc(func(ctx context.Context) error {
			stage = "wait_for"

			waitTimeout := 5 * time.Second
			if ms := options.getTimeoutMs(); ms > 0 {
				waitTimeout = time.Duration(ms) * time.Millisecond
			}

			waitCtx, waitCancel := context.WithTimeout(ctx, waitTimeout)
			defer waitCancel()

			var waitActions []chromedp.Action

			// Network Idle: "networkidle0" / "networkidle2"
			idleMode := strings.ToLower(strings.TrimSpace(options.getNetworkIdle()))
			if idleMode == "networkidle0" || idleMode == "networkidle2" {
				maxInflight := 0
				if idleMode == "networkidle2" {
					maxInflight = 2
				}
				waitActions = append(waitActions, chromedp.ActionFunc(func(c context.Context) error {
					return netTracker.waitForIdle(c, maxInflight, 500*time.Millisecond)
				}))
			}

			// Automatic Font Readiness (document.fonts.ready) & image decoding
			if !disableJavaScript && options.getWaitForFonts() {
				waitActions = append(waitActions, chromedp.ActionFunc(func(c context.Context) error {
					_, _, err := runtime.Evaluate(`(async () => {
						try {
							if (document.fonts && document.fonts.ready) {
								await document.fonts.ready;
							}
							const images = Array.from(document.images || []);
							if (images.length > 0) {
								await Promise.all(images.map(img => {
									if (img.complete) return Promise.resolve();
									return new Promise(resolve => {
										img.addEventListener('load', resolve, { once: true });
										img.addEventListener('error', resolve, { once: true });
									});
								}));
							}
							void document.body.offsetHeight;
							if (document.fonts && document.fonts.ready) {
								await document.fonts.ready;
							}
						} catch (e) {}
					})()`).WithAwaitPromise(true).Do(c)
					return err
				}))
			}

			// Canvas Animations & WebGL Quiescence: wait for canvas pixel data
			if !disableJavaScript {
				waitActions = append(waitActions, chromedp.ActionFunc(func(c context.Context) error {
					_, _, err := runtime.Evaluate(`(async () => {
						try {
							const canvases = Array.from(document.querySelectorAll('canvas'));
							if (canvases.length === 0) return;
							const start = Date.now();
							while (Date.now() - start < 1500) {
								let painted = false;
								for (const canvas of canvases) {
									if (canvas.width > 0 && canvas.height > 0) {
										const ctx = canvas.getContext('2d');
										if (ctx) {
											try {
												const pixel = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
												if (pixel[3] !== 0) {
													painted = true;
													break;
												}
											} catch (e) {}
										}
									}
								}
								if (painted) break;
								await new Promise(r => setTimeout(r, 50));
							}
						} catch (e) {}
					})()`).WithAwaitPromise(true).Do(c)
					return err
				}))
			}

			// Custom Selector Trigger
			if selector := options.getWaitForSelector(); selector != "" {
				waitActions = append(waitActions, chromedp.WaitVisible(selector, chromedp.ByQuery))
			}

			// Custom JavaScript Function Trigger
			if fn := options.getWaitForFunction(); fn != "" && !disableJavaScript {
				waitActions = append(waitActions, chromedp.Poll(fn, nil, chromedp.WithPollingInterval(50*time.Millisecond)))
			}

			if len(waitActions) > 0 {
				if err := chromedp.Run(waitCtx, waitActions...); err != nil {
					if errors.Is(err, context.DeadlineExceeded) || errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
						if ctx.Err() != nil {
							return ctx.Err()
						}
						// Safety timeout reached: proceed to print
						fmt.Printf("Readiness wait timed out after %v, proceeding to render\n", waitTimeout)
						return nil
					}
					return err
				}
			}

			if !disableJavaScript {
				_, _, _ = runtime.Evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`).WithAwaitPromise(true).Do(ctx)
			} else {
				_ = chromedp.Sleep(200 * time.Millisecond).Do(ctx)
			}

			return nil
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			stage = "printing"
			var err error
			effectiveHeader := headerTemplate
			if effectiveHeader == "" {
				effectiveHeader = defaultHeaderTemplate
			}
			effectiveFooter := footerTemplate
			if effectiveFooter == "" {
				effectiveFooter = defaultFooterTemplate
			}
			buf, _, err = page.PrintToPDF().
				WithPrintBackground(true).
				WithPreferCSSPageSize(true).
				WithScale(1).
				WithDisplayHeaderFooter(displayHeaderFooter).
				WithHeaderTemplate(effectiveHeader).
				WithFooterTemplate(effectiveFooter).
				WithMarginTop(0.5).
				WithMarginBottom(0.5).
				WithMarginLeft(0).
				WithMarginRight(0).
				Do(ctx)
			return err
		}),
	)
	err = chromedp.Run(taskCtx, actions...)
	if err != nil {
		// Keep the document payload out of logs, while recording enough context to
		// diagnose Chromium/CDP failures in the Lambda log stream.
		fmt.Printf("Chromium render failed at stage %s (%T): %v\n", stage, err, err)
		if errors.Is(err, context.DeadlineExceeded) {
			if stage == "navigation" {
				return nil, &renderError{Code: "navigation_timeout", Message: "Navigation timed out while loading the page", Status: 504}
			}
			return nil, &renderError{Code: "chromium_timeout", Message: "Chromium timed out while rendering the PDF", Status: 504}
		}
		return nil, err
	}
	if diagnosticErr := diagnostics.error(); diagnosticErr != nil {
		return nil, diagnosticErr
	}

	return buf, nil
}

// renderDiagnostics collects only failures that make the produced document
// unreliable. It is guarded because CDP event delivery is asynchronous.
type renderDiagnostics struct {
	mu        sync.Mutex
	imageFail bool
	cssFail   bool
	jsFail    bool
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
