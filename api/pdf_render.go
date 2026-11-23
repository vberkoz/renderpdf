package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/fetch"
	"github.com/chromedp/cdproto/log"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

func cdpExecutorContext(ctx context.Context) context.Context {
	if c := chromedp.FromContext(ctx); c != nil && c.Target != nil {
		return cdp.WithExecutor(ctx, c.Target)
	}
	return ctx
}

func defaultDisplayHeaderFooter() bool {
	val, err := strconv.ParseBool(strings.TrimSpace(os.Getenv("DEFAULT_DISPLAY_HEADER_FOOTER")))
	if err != nil {
		return false
	}
	return val
}

func mergeCDPRequestHeaders(existing network.Headers, custom map[string]string) []*fetch.HeaderEntry {
	customLower := make(map[string]bool, len(custom))
	keys := make([]string, 0, len(custom))
	for k := range custom {
		customLower[strings.ToLower(k)] = true
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var entries []*fetch.HeaderEntry
	if len(existing) > 0 {
		exKeys := make([]string, 0, len(existing))
		for k := range existing {
			if !customLower[strings.ToLower(k)] {
				exKeys = append(exKeys, k)
			}
		}
		sort.Strings(exKeys)
		for _, k := range exKeys {
			entries = append(entries, &fetch.HeaderEntry{
				Name:  k,
				Value: fmt.Sprint(existing[k]),
			})
		}
	}
	for _, k := range keys {
		entries = append(entries, &fetch.HeaderEntry{
			Name:  k,
			Value: custom[k],
		})
	}
	return entries
}

func resolveDisplayHeaderFooter(html string, options documentRenderOptions) bool {
	if options.DisplayHeaderFooter != nil {
		return *options.DisplayHeaderFooter
	}
	if strings.TrimSpace(options.HeaderTemplate) != "" || strings.TrimSpace(options.FooterTemplate) != "" {
		return true
	}
	if options.PageNumbers != nil || strings.Contains(strings.ToLower(html), "renderpdf:no-header-footer") {
		return false
	}
	return defaultDisplayHeaderFooter()
}

func buildCDPPrintParams(displayHeaderFooter bool, headerTemplate, footerTemplate string, cssPageOwnsLayout bool, options documentRenderOptions) *page.PrintToPDFParams {
	paperW, paperH := resolveCDPPaperSize(options.Format)
	hasPageOpts := strings.TrimSpace(options.Format) != "" || strings.TrimSpace(options.Margin) != "" || options.Landscape != nil
	preferCSSPageSize := true
	if !cssPageOwnsLayout && hasPageOpts {
		preferCSSPageSize = false
	}

	printAction := page.PrintToPDF().
		WithPrintBackground(true).
		WithGenerateTaggedPDF(true).
		WithDisplayHeaderFooter(displayHeaderFooter).
		WithLandscape(options.isLandscape()).
		WithPaperWidth(paperW).
		WithPaperHeight(paperH).
		WithPreferCSSPageSize(preferCSSPageSize)

	if displayHeaderFooter {
		topM, bottomM, leftM, rightM := resolveCDPPrintMargins(true, options.Margin)
		printAction = printAction.
			WithMarginTop(topM).
			WithMarginBottom(bottomM).
			WithMarginLeft(leftM).
			WithMarginRight(rightM).
			WithHeaderTemplate(headerTemplate).
			WithFooterTemplate(footerTemplate)
	} else if !cssPageOwnsLayout {
		if m, ok := parseMarginInches(options.Margin); ok {
			printAction = printAction.
				WithMarginTop(m).
				WithMarginBottom(m).
				WithMarginLeft(m).
				WithMarginRight(m)
		}
	}

	return printAction
}

func generatePDF(ctx context.Context, html string) ([]byte, error) {
	return generatePDFWithOptions(ctx, html, documentRenderOptions{})
}

func generatePDFWithOptions(ctx context.Context, html string, options documentRenderOptions) ([]byte, error) {
	displayHeaderFooter := resolveDisplayHeaderFooter(html, options)
	escaped := url.PathEscape(html)
	headerTmpl := options.HeaderTemplate
	footerTmpl := options.FooterTemplate
	if strings.TrimSpace(headerTmpl) == "" && strings.TrimSpace(footerTmpl) == "" && displayHeaderFooter {
		headerTmpl = defaultHeaderTemplate
		footerTmpl = defaultFooterTemplate
	}
	headerTmpl = normalizeHeaderFooterTemplate(headerTmpl)
	footerTmpl = normalizeHeaderFooterTemplate(footerTmpl)
	pdfBytes, err := generatePDFURLWithCustomSettings(ctx, "data:text/html;charset=utf-8,"+escaped, displayHeaderFooter, headerTmpl, footerTmpl, false, options)
	if err != nil {
		return nil, err
	}
	return applyPDFPostProcessing(pdfBytes, options)
}

// generateDocumentPDF is the restricted renderer for the document JSON mode.
// Its input has already passed document safety validation, and JavaScript is
// disabled as a defense in depth measure before navigation.
func generateDocumentPDF(ctx context.Context, documentHTML string) ([]byte, error) {
	return generateDocumentPDFWithOptions(ctx, documentHTML, documentRenderOptions{})
}

func generateDocumentPDFWithOptions(ctx context.Context, documentHTML string, options documentRenderOptions) ([]byte, error) {
	displayHeaderFooter := resolveDisplayHeaderFooter(documentHTML, options)
	escaped := url.PathEscape(documentHTML)
	headerTmpl := options.HeaderTemplate
	footerTmpl := options.FooterTemplate
	if strings.TrimSpace(headerTmpl) == "" && strings.TrimSpace(footerTmpl) == "" && displayHeaderFooter {
		headerTmpl = defaultHeaderTemplate
		footerTmpl = defaultFooterTemplate
	}
	headerTmpl = normalizeHeaderFooterTemplate(headerTmpl)
	footerTmpl = normalizeHeaderFooterTemplate(footerTmpl)
	pdfBytes, err := generatePDFURLWithCustomSettings(ctx, "data:text/html;charset=utf-8,"+escaped, displayHeaderFooter, headerTmpl, footerTmpl, true, options)
	if err != nil {
		return nil, err
	}
	return applyPDFPostProcessing(pdfBytes, options)
}

func generatePDFURL(ctx context.Context, targetURL string) ([]byte, error) {
	return generatePDFURLWithDocumentOptions(ctx, targetURL, documentRenderOptions{})
}

func generatePDFURLWithOptions(ctx context.Context, targetURL string, displayHeaderFooter bool) ([]byte, error) {
	return generatePDFURLWithRenderSettings(ctx, targetURL, displayHeaderFooter, false)
}

func generatePDFURLWithRenderSettings(ctx context.Context, targetURL string, displayHeaderFooter, disableJavaScript bool) ([]byte, error) {
	return generatePDFURLWithCustomSettings(ctx, targetURL, displayHeaderFooter, defaultHeaderTemplate, defaultFooterTemplate, disableJavaScript, documentRenderOptions{})
}

func generatePDFURLWithDocumentOptions(ctx context.Context, targetURL string, options documentRenderOptions) ([]byte, error) {
	displayHeaderFooter := resolveDisplayHeaderFooter("", options)
	headerTmpl := options.HeaderTemplate
	footerTmpl := options.FooterTemplate
	if strings.TrimSpace(headerTmpl) == "" && strings.TrimSpace(footerTmpl) == "" && displayHeaderFooter {
		headerTmpl = defaultHeaderTemplate
		footerTmpl = defaultFooterTemplate
	}
	headerTmpl = normalizeHeaderFooterTemplate(headerTmpl)
	footerTmpl = normalizeHeaderFooterTemplate(footerTmpl)
	pdfBytes, err := generatePDFURLWithCustomSettings(ctx, targetURL, displayHeaderFooter, headerTmpl, footerTmpl, false, options)
	if err != nil {
		return nil, err
	}
	return applyPDFPostProcessing(pdfBytes, options)
}

func shouldUseWarmPool(targetURL string, options documentRenderOptions) bool {
	if !chromeWarmPoolEnabled() {
		return false
	}
	if len(options.CustomCookies) > 0 || len(options.CustomHeaders) > 0 {
		return false
	}
	trimmed := strings.TrimSpace(targetURL)
	if parsed, err := url.Parse(trimmed); err == nil {
		scheme := strings.ToLower(parsed.Scheme)
		if scheme == "http" || scheme == "https" {
			host := strings.ToLower(parsed.Hostname())
			if host != "127.0.0.1" && host != "localhost" && host != "::1" {
				return false
			}
		}
	} else {
		lower := strings.ToLower(trimmed)
		if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
			return false
		}
	}
	return true
}

func clearWarmTabState(ctx context.Context) error {
	return chromedp.Run(ctx, network.ClearBrowserCookies(), network.ClearBrowserCache())
}

func generatePDFURLWithCustomSettings(ctx context.Context, targetURL string, displayHeaderFooter bool, headerTemplate, footerTemplate string, disableJavaScript bool, options documentRenderOptions) ([]byte, error) {
	chromePath, err := prepareChrome()
	if err != nil {
		return nil, err
	}
	fmt.Printf("Using Chrome at: %s\n", chromePath)

	if shouldUseWarmPool(targetURL, options) {
		return generatePDFURLWithWarmPool(ctx, chromePath, targetURL, displayHeaderFooter, headerTemplate, footerTemplate, disableJavaScript, options)
	}
	return generatePDFURLWithColdBrowser(ctx, chromePath, targetURL, displayHeaderFooter, headerTemplate, footerTemplate, disableJavaScript, options)
}

func generatePDFURLWithWarmPool(ctx context.Context, chromePath, targetURL string, displayHeaderFooter bool, headerTemplate, footerTemplate string, disableJavaScript bool, options documentRenderOptions) ([]byte, error) {
	for attempt := 0; attempt < 2; attempt++ {
		tabCtx, releaseTab, browserOutput, err := defaultWarmChromePool.acquireTab(chromePath)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return nil, &renderError{Code: "chromium_timeout", Message: "Chromium timed out while starting", Status: 504}
			}
			return nil, fmt.Errorf("failed to start browser: %v: %s", err, browserOutput.String())
		}

		runCtx, runCancel := context.WithTimeout(tabCtx, 24*time.Second)
		if diag := renderDiagnosticsFromContext(ctx); diag != nil {
			runCtx = withRenderDiagnostics(runCtx, diag)
		}
		stopWatch := context.AfterFunc(ctx, runCancel)

		if err := chromedp.Run(runCtx); err != nil {
			stopWatch()
			runCancel()
			releaseTab(true)
			if attempt == 0 && !errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
				continue
			}
			if errors.Is(err, context.DeadlineExceeded) {
				return nil, &renderError{Code: "chromium_timeout", Message: "Chromium timed out while starting", Status: 504}
			}
			return nil, fmt.Errorf("failed to start browser: %v: %s", err, browserOutput.String())
		}

		if err := clearWarmTabState(runCtx); err != nil {
			stopWatch()
			runCancel()
			releaseTab(true)
			if attempt == 0 && !errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
				continue
			}
			return nil, fmt.Errorf("failed to sanitize warm tab: %v", err)
		}

		buf, renderErr := runPDFRenderOnTarget(runCtx, targetURL, displayHeaderFooter, headerTemplate, footerTemplate, disableJavaScript, options)
		stopWatch()
		runCancel()

		cleanupFailed := false
		if tabCtx.Err() == nil {
			cleanupCtx, cleanupCancel := context.WithTimeout(tabCtx, 2*time.Second)
			if cleanErr := clearWarmTabState(cleanupCtx); cleanErr != nil {
				cleanupFailed = true
			}
			cleanupCancel()
		} else {
			cleanupFailed = true
		}

		if renderErr != nil {
			failedBrowser := cleanupFailed || tabCtx.Err() != nil || isWarmBrowserCrashError(renderErr)
			releaseTab(failedBrowser)
			if attempt == 0 && failedBrowser && ctx.Err() == nil && !errors.Is(renderErr, context.DeadlineExceeded) {
				continue
			}
			return nil, renderErr
		}
		releaseTab(cleanupFailed)
		return buf, nil
	}
	return nil, &renderError{Code: "render_failed", Message: "Render failed"}
}

func generatePDFURLWithColdBrowser(ctx context.Context, chromePath, targetURL string, displayHeaderFooter bool, headerTemplate, footerTemplate string, disableJavaScript bool, options documentRenderOptions) ([]byte, error) {
	// Use one deadline for the browser's entire lifetime. A launch-only child
	// context becomes Chrome's owner inside chromedp; when that shorter context
	// expires it kills an otherwise healthy browser during PDF rendering.
	generationCtx, generationCancel := context.WithTimeout(ctx, 24*time.Second)
	defer generationCancel()

	userDataDir, err := os.MkdirTemp("/tmp", "chrome-data-*")
	if err != nil {
		return nil, fmt.Errorf("create chrome temp dir: %w", err)
	}
	defer os.RemoveAll(userDataDir)

	var browserOutput bytes.Buffer
	opts := buildChromeExecOptions(chromePath, userDataDir, &browserOutput)

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

	if diag := renderDiagnosticsFromContext(ctx); diag != nil {
		taskCtx = withRenderDiagnostics(taskCtx, diag)
	}
	return runPDFRenderOnTarget(taskCtx, targetURL, displayHeaderFooter, headerTemplate, footerTemplate, disableJavaScript, options)
}

func runPDFRenderOnTarget(taskCtx context.Context, targetURL string, displayHeaderFooter bool, headerTemplate, footerTemplate string, disableJavaScript bool, options documentRenderOptions) ([]byte, error) {

	var buf []byte
	diagnostics := renderDiagnosticsFromContext(taskCtx)
	if diagnostics == nil {
		diagnostics = newRenderDiagnostics()
	}
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
				execCtx := cdpExecutorContext(taskCtx)
				_ = fetch.FailRequest(reqID, network.ErrorReasonBlockedByClient).Do(execCtx)
			}(event.RequestID)
			return
		}

		reqID := event.RequestID
		reqURL := event.Request.URL
		reqHeaders := event.Request.Headers
		go func() {
			if taskCtx.Err() != nil {
				return
			}
			execCtx := cdpExecutorContext(taskCtx)
			if !isSafeNetworkURL(reqURL) {
				fmt.Printf("SSRF filter: blocked request to %s\n", reqURL)
				diagnostics.recordSSRFBlocked(reqURL)
				_ = fetch.FailRequest(reqID, network.ErrorReasonBlockedByClient).Do(execCtx)
				return
			}
			continueReq := fetch.ContinueRequest(reqID)
			if len(options.CustomHeaders) > 0 && isSameOriginHeaderTarget(targetURL, reqURL) {
				continueReq = continueReq.WithHeaders(mergeCDPRequestHeaders(reqHeaders, options.CustomHeaders))
			}
			_ = continueReq.Do(execCtx)
		}()
	})
	stage := "navigation"

	fmt.Println("Running chromedp...")
	actions := []chromedp.Action{fetch.Enable(), network.Enable(), runtime.Enable(), log.Enable()}
	if disableJavaScript {
		actions = append(actions, emulation.SetScriptExecutionDisabled(true))
	}
	if len(options.CustomCookies) > 0 {
		actions = append(actions, chromedp.ActionFunc(func(ctx context.Context) error {
			for _, c := range options.CustomCookies {
				cmd := network.SetCookie(c.Name, c.Value).
					WithDomain(c.Domain).
					WithPath(c.Path)
				if c.Secure != nil {
					cmd = cmd.WithSecure(*c.Secure)
				}
				if c.HTTPOnly != nil {
					cmd = cmd.WithHTTPOnly(*c.HTTPOnly)
				}
				switch strings.ToLower(c.SameSite) {
				case "strict":
					cmd = cmd.WithSameSite(network.CookieSameSiteStrict)
				case "lax":
					cmd = cmd.WithSameSite(network.CookieSameSiteLax)
				case "none":
					cmd = cmd.WithSameSite(network.CookieSameSiteNone)
				}
				if err := cmd.Do(ctx); err != nil {
					return &renderError{Code: "url_cookie_set_failed", Message: "Failed to configure URL cookies", Status: 422}
				}
			}
			return nil
		}))
	}
	actions = append(actions,
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
				2,
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
		// 1. CSS & JS Animation Disable
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

					if (window.Chart) {
						if (window.Chart.defaults) {
							window.Chart.defaults.animation = false;
							if (window.Chart.defaults.transitions && window.Chart.defaults.transitions.active) {
								window.Chart.defaults.transitions.active.animation = { duration: 0 };
							}
						}
					}
					if (window.Apex) {
						window.Apex.chart = window.Apex.chart || {};
						window.Apex.chart.animations = { enabled: false };
					}
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

			// Automatic Font Readiness & image decoding
			if !disableJavaScript && options.getWaitForFonts() {
				waitActions = append(waitActions, chromedp.ActionFunc(func(c context.Context) error {
					_, _, err := runtime.Evaluate(`(async () => {
						try {
							const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
							if (links.length > 0) {
								await Promise.all(links.map(link => {
									if (link.sheet) return Promise.resolve();
									return new Promise(resolve => {
										link.addEventListener('load', resolve, { once: true });
										link.addEventListener('error', resolve, { once: true });
										setTimeout(resolve, 2000);
									});
								}));
							}

							void document.body.offsetHeight;

							if (document.fonts && document.fonts.ready) {
								await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 2000))]);
							}

							const images = Array.from(document.images || []);
							if (images.length > 0) {
								await Promise.all(images.map(img => {
									if (img.complete) return Promise.resolve();
									return new Promise(resolve => {
										img.addEventListener('load', resolve, { once: true });
										img.addEventListener('error', resolve, { once: true });
										setTimeout(resolve, 3000);
									});
								}));
							}

							void document.body.offsetHeight;
							if (document.fonts && document.fonts.ready) {
								await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 2000))]);
							}
						} catch (e) {}
					})()`).WithAwaitPromise(true).Do(c)
					return err
				}))
			}

			// Canvas, WebGL, D3 & SVG Quiescence
			if !disableJavaScript {
				waitActions = append(waitActions, chromedp.ActionFunc(func(c context.Context) error {
					_, _, err := runtime.Evaluate(`(async () => {
						try {
							const canvases = Array.from(document.querySelectorAll('canvas'));
							const svgs = Array.from(document.querySelectorAll('svg'));
							if (canvases.length === 0 && svgs.length === 0) return;

							if (window.Chart && typeof window.Chart.instances === 'object') {
								try {
									Object.values(window.Chart.instances).forEach(inst => {
										if (inst && typeof inst.stop === 'function') inst.stop();
									});
								} catch (e) {}
							}

							await Promise.race([
								new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
								new Promise(r => setTimeout(r, 250))
							]);
						} catch (e) {}
					})()`).WithAwaitPromise(true).Do(c)
					return err
				}))
			}

			// Wait For DOM Selector
			if sel := options.getWaitForSelector(); sel != "" {
				waitActions = append(waitActions, chromedp.WaitVisible(sel, chromedp.ByQuery))
			}

			// Wait For Custom JS Function Expression
			if !disableJavaScript {
				if fnExpr := options.getWaitForFunction(); fnExpr != "" {
					waitActions = append(waitActions, chromedp.ActionFunc(func(c context.Context) error {
						ticker := time.NewTicker(50 * time.Millisecond)
						defer ticker.Stop()
						for {
							select {
							case <-c.Done():
								return c.Err()
							case <-ticker.C:
								var res bool
								evalErr := chromedp.Evaluate(fmt.Sprintf(`Boolean((%s)())`, fnExpr), &res).Do(c)
								if evalErr == nil && res {
									return nil
								}
							}
						}
					}))
				}
			}

			if len(waitActions) > 0 {
				if err := chromedp.Run(waitCtx, waitActions...); err != nil {
					if errors.Is(err, context.DeadlineExceeded) || errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
						if !options.hasExplicitWaitForTrigger() && ctx.Err() == nil {
							fmt.Printf("Automatic readiness check timed out after %v, proceeding to PDF generation\n", waitTimeout)
							return nil
						}
						return &renderError{Code: "wait_for_timeout", Message: "Timeout waiting for page readiness trigger"}
					}
					return &renderError{Code: "wait_for_failed", Message: fmt.Sprintf("Wait condition failed: %v", err)}
				}
			}

			return nil
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			stage = "pdf_generation"
			return nil
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			printAction := buildCDPPrintParams(displayHeaderFooter, headerTemplate, footerTemplate, disableJavaScript, options)

			var err error
			buf, _, err = printAction.Do(ctx)
			return err
		}),
	)

	err := chromedp.Run(taskCtx, actions...)
	if err != nil {
		fmt.Printf("chromedp.Run failed at stage %s: %v\n", stage, err)

		attachDetails := func(rErr *renderError) *renderError {
			if rErr != nil && rErr.Details == nil {
				if details := diagnostics.details(); len(details) > 0 {
					rErr.Details = details
				}
			}
			return rErr
		}

		var rErr *renderError
		if errors.As(err, &rErr) {
			return nil, attachDetails(rErr)
		}

		if stage == "navigation" {
			if errors.Is(err, context.DeadlineExceeded) {
				return nil, attachDetails(&renderError{Code: "navigation_timeout", Message: "Navigation timed out", Status: 504})
			}
			return nil, attachDetails(&renderError{Code: "navigation_failed", Message: "Page navigation failed"})
		}

		if stage == "pdf_generation" {
			if diagErr := diagnostics.error(); diagErr != nil {
				return nil, diagErr
			}
			if errors.Is(err, context.DeadlineExceeded) {
				return nil, attachDetails(&renderError{Code: "pdf_generation_timeout", Message: "PDF generation timed out", Status: 504})
			}
			return nil, attachDetails(&renderError{Code: "pdf_generation_failed", Message: "Failed to generate PDF"})
		}

		if errors.Is(err, context.DeadlineExceeded) {
			return nil, attachDetails(&renderError{Code: "chromium_timeout", Message: "Rendering operation timed out", Status: 504})
		}

		return nil, attachDetails(&renderError{Code: "render_failed", Message: "Render failed"})
	}

	fmt.Printf("PDF generated successfully, size: %d bytes\n", len(buf))
	return buf, nil
}
