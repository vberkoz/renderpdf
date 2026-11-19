package main

import (
	"context"
	"errors"
	"io"
	"os"
	"sort"
	"sync/atomic"
	"testing"
	"time"
)

func TestChromeWarmPoolFlagGating(t *testing.T) {
	t.Setenv("CHROME_WARM_POOL", "")
	if !chromeWarmPoolEnabled() {
		t.Fatal("expected CHROME_WARM_POOL to default to true when unset")
	}

	for _, truthy := range []string{"true", "1", "TRUE", " true "} {
		t.Setenv("CHROME_WARM_POOL", truthy)
		if !chromeWarmPoolEnabled() {
			t.Fatalf("expected CHROME_WARM_POOL=%q to be enabled", truthy)
		}
	}

	for _, falsy := range []string{"false", "0", "FALSE", " false "} {
		t.Setenv("CHROME_WARM_POOL", falsy)
		if chromeWarmPoolEnabled() {
			t.Fatalf("expected CHROME_WARM_POOL=%q to be disabled", falsy)
		}
	}
}

func TestChromeWarmPoolReuseRecycleAndCrashRecovery(t *testing.T) {
	tmpDir := t.TempDir()
	var launches int32
	var tabsOpened int32
	var tabsClosed int32
	var browsersClosed int32

	pool := &warmChromePool{
		tmpBaseDir: tmpDir,
		maxRenders: 3,
		launchBrowser: func(chromePath, userDataDir string, output io.Writer) (context.Context, func(), error) {
			atomic.AddInt32(&launches, 1)
			ctx, cancel := context.WithCancel(context.Background())
			return ctx, func() {
				atomic.AddInt32(&browsersClosed, 1)
				cancel()
			}, nil
		},
		openTab: func(browserCtx context.Context) (context.Context, func()) {
			atomic.AddInt32(&tabsOpened, 1)
			ctx, cancel := context.WithCancel(browserCtx)
			return ctx, func() {
				atomic.AddInt32(&tabsClosed, 1)
				cancel()
			}
		},
	}

	// 1. First 3 renders reuse the exact same warm browser instance
	for i := 0; i < 3; i++ {
		_, release, _, err := pool.acquireTab("/tmp/chromium")
		if err != nil {
			t.Fatalf("acquireTab(%d) failed: %v", i, err)
		}
		release(false)
	}
	if got := atomic.LoadInt32(&launches); got != 1 {
		t.Fatalf("launches after 3 renders = %d, want 1", got)
	}
	if got := atomic.LoadInt32(&tabsOpened); got != 3 {
		t.Fatalf("tabsOpened = %d, want 3", got)
	}
	if got := atomic.LoadInt32(&tabsClosed); got != 3 {
		t.Fatalf("tabsClosed = %d, want 3", got)
	}

	// 2. 4th render triggers automatic recycle because maxRenders == 3
	_, release4, _, err := pool.acquireTab("/tmp/chromium")
	if err != nil {
		t.Fatalf("acquireTab(4) failed: %v", err)
	}
	release4(false)
	if got := atomic.LoadInt32(&launches); got != 2 {
		t.Fatalf("launches after 4th render = %d, want 2", got)
	}
	if got := atomic.LoadInt32(&browsersClosed); got != 1 {
		t.Fatalf("browsersClosed after recycle = %d, want 1", got)
	}

	// 3. Simulated crash on 5th render retires the unhealthy browser immediately
	_, release5, _, err := pool.acquireTab("/tmp/chromium")
	if err != nil {
		t.Fatalf("acquireTab(5) failed: %v", err)
	}
	release5(true) // failed=true retires and cleans up instance #2
	if got := atomic.LoadInt32(&browsersClosed); got != 2 {
		t.Fatalf("browsersClosed after crash = %d, want 2", got)
	}

	// 4. Next render spawns fresh instance #3 and reset() cleans up all temp directories
	_, release6, _, err := pool.acquireTab("/tmp/chromium")
	if err != nil {
		t.Fatalf("acquireTab(6) failed: %v", err)
	}
	release6(false)
	if got := atomic.LoadInt32(&launches); got != 3 {
		t.Fatalf("launches after recovery = %d, want 3", got)
	}

	pool.reset()
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		t.Fatalf("ReadDir(%s) failed: %v", tmpDir, err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected 0 leaked profile dirs in %s, found %d", tmpDir, len(entries))
	}
}

func TestChromeWarmPoolLaunchFailureCleansUpTempDir(t *testing.T) {
	tmpDir := t.TempDir()
	pool := &warmChromePool{
		tmpBaseDir: tmpDir,
		maxRenders: 50,
		launchBrowser: func(chromePath, userDataDir string, output io.Writer) (context.Context, func(), error) {
			_, _ = output.Write([]byte("failed to bind crashpad"))
			return nil, nil, errors.New("launch error")
		},
	}

	_, _, out, err := pool.acquireTab("/tmp/chromium")
	if err == nil {
		t.Fatal("expected acquireTab to fail when launchBrowser fails")
	}
	if out == nil || out.String() != "failed to bind crashpad" {
		t.Fatalf("unexpected output buffer: %v", out)
	}
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		t.Fatalf("ReadDir(%s) failed: %v", tmpDir, err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected 0 leaked profile dirs after launch failure, found %d", len(entries))
	}
}

func TestChromeWarmPool500RequestSoakZeroTmpLeakAndLatencyDrop(t *testing.T) {
	const totalRequests = 500
	const simulatedColdLaunchLatency = 200 * time.Microsecond
	const simulatedTabRenderLatency = 30 * time.Microsecond

	// 1. Measure cold per-request browser spawn across 500 requests
	coldTmpDir := t.TempDir()
	coldDurations := make([]time.Duration, totalRequests)
	for i := 0; i < totalRequests; i++ {
		start := time.Now()
		dir, err := os.MkdirTemp(coldTmpDir, "chrome-data-*")
		if err != nil {
			t.Fatalf("cold MkdirTemp failed: %v", err)
		}
		time.Sleep(simulatedColdLaunchLatency + simulatedTabRenderLatency)
		_ = os.RemoveAll(dir)
		coldDurations[i] = time.Since(start)
	}

	// 2. Measure warm pool across 500 requests (recycles every 50 renders)
	warmTmpDir := t.TempDir()
	var warmLaunches int32
	pool := &warmChromePool{
		tmpBaseDir: warmTmpDir,
		maxRenders: maxWarmBrowserRenders,
		launchBrowser: func(chromePath, userDataDir string, output io.Writer) (context.Context, func(), error) {
			atomic.AddInt32(&warmLaunches, 1)
			time.Sleep(simulatedColdLaunchLatency)
			ctx, cancel := context.WithCancel(context.Background())
			return ctx, cancel, nil
		},
		openTab: func(browserCtx context.Context) (context.Context, func()) {
			ctx, cancel := context.WithCancel(browserCtx)
			return ctx, cancel
		},
	}

	warmDurations := make([]time.Duration, totalRequests)
	for i := 0; i < totalRequests; i++ {
		start := time.Now()
		_, release, _, err := pool.acquireTab("/tmp/chromium")
		if err != nil {
			t.Fatalf("warm acquireTab(%d) failed: %v", i, err)
		}
		time.Sleep(simulatedTabRenderLatency)
		release(false)
		warmDurations[i] = time.Since(start)

		// Verify at most 1 active profile directory exists in tmpBaseDir during the 500-req soak
		entries, err := os.ReadDir(warmTmpDir)
		if err != nil {
			t.Fatalf("ReadDir during soak failed: %v", err)
		}
		if len(entries) > 1 {
			t.Fatalf("iter %d: expected at most 1 active warm profile dir, got %d", i, len(entries))
		}
	}

	pool.reset()
	remaining, err := os.ReadDir(warmTmpDir)
	if err != nil {
		t.Fatalf("ReadDir after reset failed: %v", err)
	}
	if len(remaining) != 0 {
		t.Fatalf("expected 0 /tmp directory leaks after 500-req soak, found %d", len(remaining))
	}

	wantLaunches := int32(totalRequests / maxWarmBrowserRenders)
	if got := atomic.LoadInt32(&warmLaunches); got != wantLaunches {
		t.Fatalf("warm browser launches over 500 requests = %d, want %d", got, wantLaunches)
	}

	p95Index := (totalRequests * 95) / 100
	sort.Slice(coldDurations, func(i, j int) bool { return coldDurations[i] < coldDurations[j] })
	sort.Slice(warmDurations, func(i, j int) bool { return warmDurations[i] < warmDurations[j] })
	coldP95 := coldDurations[p95Index]
	warmP95 := warmDurations[p95Index]

	if warmP95*2 > coldP95 {
		t.Fatalf("expected warm P95 (%s) to drop >= 50%% vs cold P95 (%s)", warmP95, coldP95)
	}
}
