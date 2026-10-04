package main

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/andybalholm/brotli"
)

var (
	chromeSetupOnce sync.Once
	chromeSetupErr  error
)

func prepareChrome() (string, error) {
	const (
		bundleRoot = "/opt/chromium"
		chromePath = "/tmp/chromium"
	)

	chromeSetupOnce.Do(func() {
		startedAt := time.Now()
		if err := inflateBrotliFile(filepath.Join(bundleRoot, "chromium.br"), chromePath, 0700); err != nil {
			chromeSetupErr = err
			return
		}
		if err := extractBrotliTar(filepath.Join(bundleRoot, "fonts.tar.br"), "/tmp/fonts"); err != nil {
			chromeSetupErr = err
			return
		}
		if err := extractBrotliTar(filepath.Join(bundleRoot, "al2023.tar.br"), "/tmp/al2023"); err != nil {
			chromeSetupErr = err
			return
		}
		if err := extractBrotliTar(filepath.Join(bundleRoot, "swiftshader.tar.br"), "/tmp"); err != nil {
			chromeSetupErr = err
			return
		}
		os.Setenv("FONTCONFIG_PATH", "/tmp/fonts")
		os.Setenv("LD_LIBRARY_PATH", "/tmp:/tmp/al2023/lib:"+os.Getenv("LD_LIBRARY_PATH"))

		fmt.Printf("Chrome extraction completed in %s\n", time.Since(startedAt))
	})

	if chromeSetupErr != nil {
		return "", fmt.Errorf("prepare Chrome: %w", chromeSetupErr)
	}
	return chromePath, nil
}

func inflateBrotliFile(sourcePath, targetPath string, mode os.FileMode) error {
	input, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open %s: %w", sourcePath, err)
	}
	defer input.Close()

	output, err := os.OpenFile(targetPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return fmt.Errorf("create %s: %w", targetPath, err)
	}
	_, copyErr := io.Copy(output, brotli.NewReader(input))
	closeErr := output.Close()
	if copyErr != nil {
		return fmt.Errorf("decompress %s: %w", sourcePath, copyErr)
	}
	return closeErr
}

func extractBrotliTar(sourcePath, targetRoot string) error {
	input, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open %s: %w", sourcePath, err)
	}
	defer input.Close()
	if err := os.MkdirAll(targetRoot, 0755); err != nil {
		return err
	}

	archive := tar.NewReader(brotli.NewReader(input))
	for {
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read %s: %w", sourcePath, err)
		}
		target := filepath.Join(targetRoot, header.Name)
		if !strings.HasPrefix(target, targetRoot+string(os.PathSeparator)) {
			return fmt.Errorf("invalid archive path %q", header.Name)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, os.FileMode(header.Mode)); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			output, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(header.Mode))
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(output, archive)
			closeErr := output.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		}
	}
}
