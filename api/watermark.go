package main

import (
	"bytes"
	"fmt"
	"strconv"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

// watermarkOptions defines diagonal or custom vector watermarks stamped via pdfcpu.
type watermarkOptions struct {
	Text     string   `json:"text"`               // Watermark text e.g. "DRAFT", "CONFIDENTIAL"
	Diagonal *bool    `json:"diagonal,omitempty"` // Paint along diagonal (default: true)
	Rotation *int     `json:"rotation,omitempty"` // Custom rotation angle (-360 to 360). Overrides Diagonal if set.
	Opacity  *float64 `json:"opacity,omitempty"`  // Opacity: 0.0 to 1.0 (default: 0.15)
	Color    string   `json:"color,omitempty"`    // Hex "#ff0000" or rgb normalized "0.5 0.5 0.5" (default: "0.5 0.5 0.5")
	FontSize int      `json:"fontSize,omitempty"` // Font size in points (default: 54)
	Font     string   `json:"font,omitempty"`     // "Helvetica" (default), "Times-Roman", "Courier"
	Pages    string   `json:"pages,omitempty"`    // Page range e.g. "all", "odd", "even", "1", "2-" (default: "all")
	Position string   `json:"position,omitempty"` // "center" (default), "top-center", etc.
	OnTop    *bool    `json:"onTop,omitempty"`    // Stamp on top (default: true) vs behind content
}

// parseColorDesc converts hex (#RRGGBB, #RGB) or normalized RGB floats ("0.5 0.5 0.5")
// into pdfcpu's "c:r g b" color description string.
func parseColorDesc(colorStr string) (string, error) {
	trimmed := strings.TrimSpace(colorStr)
	if trimmed == "" {
		return "c:0.5 0.5 0.5", nil
	}
	if strings.HasPrefix(trimmed, "#") {
		hexStr := strings.TrimPrefix(trimmed, "#")
		if len(hexStr) == 3 {
			hexStr = string([]byte{hexStr[0], hexStr[0], hexStr[1], hexStr[1], hexStr[2], hexStr[2]})
		}
		if len(hexStr) != 6 {
			return "", fmt.Errorf("invalid hex color %q", colorStr)
		}
		r, err1 := strconv.ParseUint(hexStr[0:2], 16, 8)
		g, err2 := strconv.ParseUint(hexStr[2:4], 16, 8)
		b, err3 := strconv.ParseUint(hexStr[4:6], 16, 8)
		if err1 != nil || err2 != nil || err3 != nil {
			return "", fmt.Errorf("invalid hex color %q", colorStr)
		}
		return fmt.Sprintf("c:%.3f %.3f %.3f", float64(r)/255.0, float64(g)/255.0, float64(b)/255.0), nil
	}

	parts := strings.Fields(trimmed)
	if len(parts) != 3 {
		return "", fmt.Errorf("color must be 3 RGB floats (e.g. '0.5 0.5 0.5') or hex (#RRGGBB)")
	}
	for _, p := range parts {
		val, err := strconv.ParseFloat(p, 64)
		if err != nil || val < 0 || val > 1 {
			return "", fmt.Errorf("color RGB components must be between 0.0 and 1.0")
		}
	}
	return "c:" + trimmed, nil
}

// buildWatermarkDesc builds the pdfcpu text watermark description string and configuration.
func buildWatermarkDesc(opts *watermarkOptions) (string, bool, []string, error) {
	posDesc := "pos:c"
	if opts.Position != "" {
		switch strings.ToLower(strings.TrimSpace(opts.Position)) {
		case "top-center":
			posDesc = "pos:tc"
		case "top-left":
			posDesc = "pos:tl"
		case "top-right":
			posDesc = "pos:tr"
		case "bottom-center":
			posDesc = "pos:bc"
		case "bottom-left":
			posDesc = "pos:bl"
		case "bottom-right":
			posDesc = "pos:br"
		case "center", "":
			posDesc = "pos:c"
		default:
			return "", false, nil, fmt.Errorf("unsupported watermark position %q", opts.Position)
		}
	}

	var rotDesc string
	if opts.Rotation != nil {
		rotDesc = fmt.Sprintf("rot:%d", *opts.Rotation)
	} else if opts.Diagonal != nil && !*opts.Diagonal {
		rotDesc = "rot:0"
	} else {
		// Native corner-to-corner diagonal
		rotDesc = "d:1"
	}

	opacity := 0.15
	if opts.Opacity != nil {
		opacity = *opts.Opacity
	}
	opDesc := fmt.Sprintf("op:%.2f", opacity)

	fontSize := 54
	if opts.FontSize > 0 {
		fontSize = opts.FontSize
	}

	colorDesc, err := parseColorDesc(opts.Color)
	if err != nil {
		return "", false, nil, err
	}

	fontName := "Helvetica"
	if opts.Font != "" {
		switch strings.ToLower(strings.TrimSpace(opts.Font)) {
		case "times-roman", "times":
			fontName = "Times-Roman"
		case "courier":
			fontName = "Courier"
		case "helvetica":
			fontName = "Helvetica"
		default:
			return "", false, nil, fmt.Errorf("unsupported watermark font %q", opts.Font)
		}
	}

	onTop := true
	if opts.OnTop != nil {
		onTop = *opts.OnTop
	}

	var pageSelection []string
	if opts.Pages != "" && !strings.EqualFold(strings.TrimSpace(opts.Pages), "all") {
		pageSelection = []string{strings.TrimSpace(opts.Pages)}
	}

	desc := fmt.Sprintf("%s, %s, %s, points:%d, %s, font:%s, scale:1.0 abs", posDesc, rotDesc, opDesc, fontSize, colorDesc, fontName)
	return desc, onTop, pageSelection, nil
}

// applyPDFWatermark stamps a diagonal or custom-positioned text watermark across
// the PDF document using pdfcpu.
func applyPDFWatermark(pdfBytes []byte, options documentRenderOptions) ([]byte, error) {
	if options.Watermark == nil {
		return pdfBytes, nil
	}
	opts := options.Watermark
	text := strings.TrimSpace(opts.Text)
	if text == "" {
		return pdfBytes, nil
	}

	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed

	desc, onTop, pageSelection, err := buildWatermarkDesc(opts)
	if err != nil {
		return nil, err
	}

	wm, err := api.TextWatermark(text, desc, onTop, false, types.POINTS)
	if err != nil {
		return nil, fmt.Errorf("create watermark: %w", err)
	}

	var stamped bytes.Buffer
	if err := api.AddWatermarks(bytes.NewReader(pdfBytes), &stamped, pageSelection, wm, conf); err != nil {
		return nil, fmt.Errorf("apply watermark: %w", err)
	}

	return stamped.Bytes(), nil
}
