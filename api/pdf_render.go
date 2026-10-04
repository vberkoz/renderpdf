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
	pdfBytes, err := generatePDFURLWithCustomSettings(ctx, "data:text/html;charset=utf-8,"+escaped, displayHeaderFooter, headerTmpl, footerTmpl, false)
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
	pdfBytes, err := generatePDFURLWithCustomSettings(ctx, "data:text/html;charset=utf-8,"+escaped, displayHeaderFooter, headerTmpl, footerTmpl, true)
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
	return generatePDFURLWithCustomSettings(ctx, targetURL, displayHeaderFooter, defaultHeaderTemplate, defaultFooterTemplate, disableJavaScript)
}

func generatePDFURLWithCustomSettings(ctx context.Context, targetURL string, displayHeaderFooter bool, headerTemplate, footerTemplate string, disableJavaScript bool) ([]byte, error) {
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
		// Explicitly await font loading and image decoding before printing.
		// Headless Chrome renders lazily loaded @font-face rules with fallback fonts
		// unless document.fonts.ready has resolved under the active print media styles.
		chromedp.ActionFunc(func(ctx context.Context) error {
			if disableJavaScript {
				return nil
			}
			_, _, _ = runtime.Evaluate(`(async () => {
				try {
					if (document.fonts) {
						await Promise.race([
							document.fonts.ready,
							new Promise(resolve => setTimeout(resolve, 2500))
						]);
					}
					const images = Array.from(document.images || []);
					if (images.length > 0) {
						await Promise.race([
							Promise.all(images.map(img => {
								if (img.complete) return Promise.resolve();
								return new Promise(resolve => {
									img.addEventListener('load', resolve, { once: true });
									img.addEventListener('error', resolve, { once: true });
								});
							})),
							new Promise(resolve => setTimeout(resolve, 2000))
						]);
					}
					void document.body.offsetHeight;
					if (document.fonts) {
						await Promise.race([
							document.fonts.ready,
							new Promise(resolve => setTimeout(resolve, 1500))
						]);
					}
				} catch (e) {}
			})()`).WithAwaitPromise(true).Do(ctx)
			return nil
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			if disableJavaScript {
				return chromedp.Sleep(1 * time.Second).Do(ctx)
			}
			return chromedp.Sleep(250 * time.Millisecond).Do(ctx)
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
