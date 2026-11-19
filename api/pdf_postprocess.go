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

func resolveCDPPrintMargins(displayHeaderFooter bool, marginStr string) (top, bottom, left, right float64) {
	if !displayHeaderFooter {
		return 0, 0, 0, 0
	}

	marginInches := 0.5
	if strings.TrimSpace(marginStr) != "" {
		if match := documentMarginPattern.FindStringSubmatch(strings.TrimSpace(marginStr)); match != nil {
			val, _ := strconv.ParseFloat(match[1], 64)
			if match[2] == "mm" {
				marginInches = val / 25.4
			} else {
				marginInches = val
			}
		}
	}

	top = marginInches
	bottom = marginInches
	if top < 0.35 {
		top = 0.35
	}
	if bottom < 0.35 {
		bottom = 0.35
	}
	left = marginInches
	right = marginInches
	return top, bottom, left, right
}

func resolveCDPPaperSize(format string) (widthIn, heightIn float64) {
	switch strings.TrimSpace(format) {
	case "Letter":
		return 8.5, 11.0
	case "Legal":
		return 8.5, 14.0
	default:
		return 210.0 / 25.4, 297.0 / 25.4
	}
}

func parseMarginInches(marginStr string) (float64, bool) {
	trimmed := strings.TrimSpace(marginStr)
	if trimmed == "" {
		return 0, false
	}
	match := documentMarginPattern.FindStringSubmatch(trimmed)
	if match == nil {
		return 0, false
	}
	val, err := strconv.ParseFloat(match[1], 64)
	if err != nil {
		return 0, false
	}
	if match[2] == "mm" {
		return val / 25.4, true
	}
	return val, true
}

func normalizeHeaderFooterTemplate(tmpl string) string {
	t := strings.TrimSpace(tmpl)
	if t == "" {
		return "<span></span>"
	}
	if !strings.Contains(t, "font-size") {
		return fmt.Sprintf(`<div style="font-size:10px; color:#888; width:100%%; text-align:center;">%s</div>`, t)
	}
	return t
}

func applyPDFPageNumbers(pdfBytes []byte, options documentRenderOptions) ([]byte, error) {
	if options.PageNumbers == nil {
		return pdfBytes, nil
	}

	pn := options.PageNumbers
	formatStr := pn.Format
	if formatStr == "" {
		formatStr = "{page} / {total}"
	}

	startPage := pn.StartPage
	if startPage <= 0 {
		startPage = 1
	}

	startNumber := pn.StartNumber
	if startNumber <= 0 {
		startNumber = 1
	}

	pageCount, err := api.PageCount(bytes.NewReader(pdfBytes), nil)
	if err != nil {
		return nil, fmt.Errorf("read page count: %w", err)
	}

	pos := strings.ToLower(strings.TrimSpace(pn.Position))
	if pos == "" {
		pos = "bottom-center"
	}
	var alignStr string
	switch pos {
	case "bottom-center":
		alignStr = "pos:bc, off:0 20"
	case "bottom-right":
		alignStr = "pos:br, off:-30 20"
	case "bottom-left":
		alignStr = "pos:bl, off:30 20"
	case "top-center":
		alignStr = "pos:tc, off:0 -20"
	case "top-right":
		alignStr = "pos:tr, off:-30 -20"
	case "top-left":
		alignStr = "pos:tl, off:30 -20"
	default:
		alignStr = "pos:bc, off:0 20"
	}

	fontSize := pn.FontSize
	if fontSize <= 0 {
		fontSize = 9
	}

	fontColor := "0.3 0.3 0.3"
	if pn.Color != "" {
		colorStr := strings.TrimSpace(pn.Color)
		if strings.HasPrefix(colorStr, "#") && len(colorStr) == 7 {
			r, err1 := strconv.ParseInt(colorStr[1:3], 16, 64)
			g, err2 := strconv.ParseInt(colorStr[3:5], 16, 64)
			b, err3 := strconv.ParseInt(colorStr[5:7], 16, 64)
			if err1 == nil && err2 == nil && err3 == nil {
				fontColor = fmt.Sprintf("%.2f %.2f %.2f", float64(r)/255.0, float64(g)/255.0, float64(b)/255.0)
			}
		} else {
			fontColor = colorStr
		}
	}

	currentBytes := pdfBytes
	for page := 1; page <= pageCount; page++ {
		if pn.ExcludeCover && page == 1 {
			continue
		}
		if page < startPage {
			continue
		}

		displayedNumber := startNumber + (page - startPage)
		totalCount := pageCount
		if pn.ExcludeCover {
			totalCount = pageCount - 1
		}

		text := strings.ReplaceAll(formatStr, "{page}", strconv.Itoa(displayedNumber))
		text = strings.ReplaceAll(text, "{total}", strconv.Itoa(totalCount))

		wmDesc := fmt.Sprintf("%s, points:%d, fillc:%s, %s, rot:0, op:1.0", text, fontSize, fontColor, alignStr)
		wm, err := api.TextWatermark(wmDesc, "font:Helvetica", true, false, types.POINTS)
		if err != nil {
			return nil, fmt.Errorf("create page number watermark: %w", err)
		}

		var out bytes.Buffer
		pageSelection := []string{strconv.Itoa(page)}
		if err := api.AddWatermarks(bytes.NewReader(currentBytes), &out, pageSelection, wm, nil); err != nil {
			return nil, fmt.Errorf("stamp page number on page %d: %w", page, err)
		}
		currentBytes = out.Bytes()
	}

	return currentBytes, nil
}

func applyPDFPostProcessing(pdfBytes []byte, options documentRenderOptions) ([]byte, error) {
	var err error
	pdfBytes, err = applyPDFPageNumbers(pdfBytes, options)
	if err != nil {
		return nil, err
	}
	pdfBytes, err = applyPDFWatermark(pdfBytes, options)
	if err != nil {
		return nil, err
	}
	pdfBytes, err = applyPDFCompliance(pdfBytes, options)
	if err != nil {
		return nil, err
	}
	pdfBytes, err = applyPDFSecurity(pdfBytes, options)
	if err != nil {
		return nil, err
	}
	return pdfBytes, nil
}
