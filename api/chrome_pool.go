package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/chromedp"
)

const (
	maxWarmBrowserRenders   = 50
	warmBrowserStartTimeout = 18 * time.Second
)

func chromeWarmPoolEnabled() bool {
	raw := strings.TrimSpace(os.Getenv("CHROME_WARM_POOL"))
	if raw == "" {
		return true
	}
	enabled, err := strconv.ParseBool(raw)
	if err != nil {
		return true
	}
	return enabled
}

type boundedSyncBuffer struct {
	mu  sync.Mutex
	max int
	buf bytes.Buffer
}

func newBoundedSyncBuffer(max int) *boundedSyncBuffer {
	return &boundedSyncBuffer{max: max}
}

func (b *boundedSyncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.max > 0 && b.buf.Len()+len(p) > b.max {
		keep := b.max / 2
		cur := b.buf.Bytes()
		if len(cur) > keep {
			cur = cur[len(cur)-keep:]
		}
		var next bytes.Buffer
		next.Write(cur)
		b.buf = next
	}
	return b.buf.Write(p)
}

func (b *boundedSyncBuffer) String() string {
	if b == nil {
		return ""
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func buildChromeExecOptions(chromePath, userDataDir string, output io.Writer) []chromedp.ExecAllocatorOption {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(chromePath),
		chromedp.WSURLReadTimeout(18*time.Second),
		chromedp.NoSandbox,
		chromedp.DisableGPU,
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("disable-setuid-sandbox", true),
		chromedp.Flag("no-zygote", true),
		chromedp.Flag("single-process", true),
		chromedp.Flag("no-proxy-server", true),
		chromedp.Flag("allow-file-access-from-files", true),
		chromedp.Flag("proxy-bypass-list", "*"),
		chromedp.UserDataDir(userDataDir),
		chromedp.WindowSize(1920, 1080),
	)
	if output != nil {
		opts = append(opts, chromedp.CombinedOutput(output))
	}
	return opts
}

type warmBrowserInstance struct {
	browserCtx   context.Context
	closeBrowser func()
	userDataDir  string
	output       *boundedSyncBuffer
	renders      int
	activeTabs   int
	retired      bool
}

type warmChromePool struct {
	mu            sync.Mutex
	tmpBaseDir    string
	maxRenders    int
	current       *warmBrowserInstance
	launchBrowser func(chromePath, userDataDir string, output io.Writer) (context.Context, func(), error)
	openTab       func(browserCtx context.Context) (context.Context, func())
}

var defaultWarmChromePool = &warmChromePool{
	tmpBaseDir: "/tmp",
	maxRenders: maxWarmBrowserRenders,
}

func (p *warmChromePool) maxLimit() int {
	if p.maxRenders <= 0 {
		return maxWarmBrowserRenders
	}
	return p.maxRenders
}

func defaultLaunchWarmBrowser(chromePath, userDataDir string, output io.Writer) (context.Context, func(), error) {
	opts := buildChromeExecOptions(chromePath, userDataDir, output)
	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)
	browserCtx, browserCancel := chromedp.NewContext(
		allocCtx,
		chromedp.WithLogf(func(format string, args ...interface{}) {
			fmt.Printf("chromedp: "+format+"\n", args...)
		}),
		chromedp.WithErrorf(func(format string, args ...interface{}) {
			fmt.Printf("chromedp ERROR: "+format+"\n", args...)
		}),
	)

	startErrCh := make(chan error, 1)
	go func() {
		startErrCh <- chromedp.Run(browserCtx)
	}()

	timer := time.NewTimer(warmBrowserStartTimeout)
	defer timer.Stop()

	select {
	case err := <-startErrCh:
		if err != nil {
			browserCancel()
			allocCancel()
			return nil, nil, err
		}
		return browserCtx, func() {
			browserCancel()
			allocCancel()
		}, nil
	case <-timer.C:
		browserCancel()
		allocCancel()
		<-startErrCh
		return nil, nil, context.DeadlineExceeded
	}
}

func defaultOpenWarmTab(browserCtx context.Context) (context.Context, func()) {
	return chromedp.NewContext(browserCtx, chromedp.WithNewBrowserContext())
}

func (p *warmChromePool) acquireTab(chromePath string) (context.Context, func(failed bool), *boundedSyncBuffer, error) {
	for {
		p.mu.Lock()
		inst := p.current
		if inst != nil && (inst.retired || inst.browserCtx.Err() != nil || inst.renders >= p.maxLimit()) {
			inst.retired = true
			p.current = nil
			if inst.activeTabs == 0 && inst.closeBrowser != nil {
				closeFn := inst.closeBrowser
				inst.closeBrowser = nil
				dir := inst.userDataDir
				p.mu.Unlock()
				closeFn()
				if dir != "" {
					_ = os.RemoveAll(dir)
				}
				continue
			}
		}

		if p.current == nil {
			baseDir := p.tmpBaseDir
			if baseDir == "" {
				baseDir = "/tmp"
			}
			userDataDir, err := os.MkdirTemp(baseDir, "chrome-warm-profile-*")
			if err != nil {
				p.mu.Unlock()
				return nil, nil, nil, err
			}
			out := newBoundedSyncBuffer(64 * 1024)
			launchFn := p.launchBrowser
			if launchFn == nil {
				launchFn = defaultLaunchWarmBrowser
			}
			browserCtx, closeBrowser, err := launchFn(chromePath, userDataDir, out)
			if err != nil {
				p.mu.Unlock()
				_ = os.RemoveAll(userDataDir)
				return nil, nil, out, err
			}
			p.current = &warmBrowserInstance{
				browserCtx:   browserCtx,
				closeBrowser: closeBrowser,
				userDataDir:  userDataDir,
				output:       out,
			}
		}

		inst = p.current
		inst.renders++
		inst.activeTabs++
		openFn := p.openTab
		if openFn == nil {
			openFn = defaultOpenWarmTab
		}
		tabCtx, closeTab := openFn(inst.browserCtx)
		p.mu.Unlock()

		var once sync.Once
		release := func(failed bool) {
			once.Do(func() {
				if closeTab != nil {
					closeTab()
				}
				var closeFn func()
				var dir string
				p.mu.Lock()
				inst.activeTabs--
				if failed || inst.browserCtx.Err() != nil {
					inst.retired = true
					if p.current == inst {
						p.current = nil
					}
				}
				if inst.retired && inst.activeTabs == 0 && inst.closeBrowser != nil {
					closeFn = inst.closeBrowser
					inst.closeBrowser = nil
					dir = inst.userDataDir
				}
				p.mu.Unlock()
				if closeFn != nil {
					closeFn()
				}
				if dir != "" {
					_ = os.RemoveAll(dir)
				}
			})
		}

		return tabCtx, release, inst.output, nil
	}
}

func (p *warmChromePool) reset() {
	p.mu.Lock()
	inst := p.current
	p.current = nil
	var closeFn func()
	var dir string
	if inst != nil {
		inst.retired = true
		if inst.activeTabs == 0 && inst.closeBrowser != nil {
			closeFn = inst.closeBrowser
			inst.closeBrowser = nil
			dir = inst.userDataDir
		}
	}
	p.mu.Unlock()
	if closeFn != nil {
		closeFn()
	}
	if dir != "" {
		_ = os.RemoveAll(dir)
	}
}

func isWarmBrowserCrashError(err error) bool {
	if err == nil {
		return false
	}
	var rErr *renderError
	if errorsAsRender(err, &rErr) {
		switch rErr.Code {
		case "chromium_timeout", "pdf_generation_timeout", "pdf_generation_failed", "render_failed":
			return true
		default:
			return false
		}
	}
	return true
}

func errorsAsRender(err error, target **renderError) bool {
	rErr, ok := err.(*renderError)
	if ok {
		*target = rErr
	}
	return ok
}
