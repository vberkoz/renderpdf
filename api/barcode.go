package main

import (
	"bytes"
	"fmt"
	"html"
	"image/color"
	"strconv"
	"strings"

	"github.com/boombuler/barcode"
	"github.com/boombuler/barcode/code128"
	"github.com/boombuler/barcode/code39"
	"github.com/boombuler/barcode/datamatrix"
	"github.com/boombuler/barcode/ean"
	"github.com/boombuler/barcode/pdf417"
	"github.com/boombuler/barcode/twooffive"
	"github.com/skip2/go-qrcode"
	nethtml "golang.org/x/net/html"
)

// generateQRCodeSVG generates a compact, resolution-independent vector SVG for a QR code.
func generateQRCodeSVG(value string, size string, levelStr string, fgColor, bgColor, class, id, style string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("qr code value cannot be empty")
	}

	level := qrcode.Medium
	switch strings.ToUpper(strings.TrimSpace(levelStr)) {
	case "L", "LOW":
		level = qrcode.Low
	case "M", "MEDIUM", "":
		level = qrcode.Medium
	case "Q", "QUARTILE":
		level = qrcode.High
	case "H", "HIGH", "HIGHEST":
		level = qrcode.Highest
	}

	qr, err := qrcode.New(value, level)
	if err != nil {
		return "", err
	}

	bitmap := qr.Bitmap()
	n := len(bitmap)
	if n == 0 {
		return "", fmt.Errorf("empty qr code matrix")
	}

	if fgColor == "" {
		fgColor = "#000000"
	}
	if bgColor == "" {
		bgColor = "#ffffff"
	}
	if size == "" {
		size = "128px"
	} else if _, err := strconv.Atoi(size); err == nil {
		size = size + "px"
	}

	var pathBuf strings.Builder
	for y := 0; y < n; y++ {
		start := -1
		for x := 0; x < n; x++ {
			if bitmap[y][x] {
				if start == -1 {
					start = x
				}
			} else {
				if start != -1 {
					w := x - start
					fmt.Fprintf(&pathBuf, "M%d,%dh%dv1h-%dz", start, y, w, w)
					start = -1
				}
			}
		}
		if start != -1 {
			w := n - start
			fmt.Fprintf(&pathBuf, "M%d,%dh%dv1h-%dz", start, y, w, w)
		}
	}

	var extraAttrs strings.Builder
	if class != "" {
		fmt.Fprintf(&extraAttrs, ` class="%s"`, html.EscapeString(class))
	}
	if id != "" {
		fmt.Fprintf(&extraAttrs, ` id="%s"`, html.EscapeString(id))
	}
	if style != "" {
		fmt.Fprintf(&extraAttrs, ` style="%s"`, html.EscapeString(style))
	}

	var bgRect string
	if strings.ToLower(bgColor) != "none" && strings.ToLower(bgColor) != "transparent" {
		bgRect = fmt.Sprintf(`<rect width="100%%" height="100%%" fill="%s"/>`, html.EscapeString(bgColor))
	}

	return fmt.Sprintf(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%s" height="%s" shape-rendering="crispEdges"%s>%s<path d="%s" fill="%s"/></svg>`,
		n, n, html.EscapeString(size), html.EscapeString(size), extraAttrs.String(), bgRect, pathBuf.String(), html.EscapeString(fgColor),
	), nil
}

// generateBarcodeSVG creates an SVG representation of 1D and 2D barcodes.
func generateBarcodeSVG(bType, value string, widthStr, heightStr string, showText bool, fgColor, bgColor, class, id, style string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("barcode value cannot be empty")
	}

	if fgColor == "" {
		fgColor = "#000000"
	}
	if bgColor == "" {
		bgColor = "#ffffff"
	}

	normalizedType := strings.ToLower(strings.TrimSpace(bType))
	if normalizedType == "" {
		normalizedType = "code128"
	}

	var bc barcode.Barcode
	var err error

	switch normalizedType {
	case "code128", "128":
		bc, err = code128.Encode(value)
	case "code39", "39":
		bc, err = code39.Encode(strings.ToUpper(value), true, true)
	case "ean", "ean13", "ean8":
		bc, err = ean.Encode(value)
	case "2of5", "itf", "interleaved2of5":
		bc, err = twooffive.Encode(value, true)
	case "datamatrix":
		bc, err = datamatrix.Encode(value)
	case "pdf417":
		bc, err = pdf417.Encode(value, 3)
	case "qr", "qrcode", "qr-code":
		return generateQRCodeSVG(value, widthStr, "M", fgColor, bgColor, class, id, style)
	default:
		return "", fmt.Errorf("unsupported barcode type %q", bType)
	}

	if err != nil {
		return "", err
	}

	bounds := bc.Bounds()
	dx := bounds.Dx()
	dy := bounds.Dy()
	if dx == 0 || dy == 0 {
		return "", fmt.Errorf("empty barcode bounds")
	}

	var extraAttrs strings.Builder
	if class != "" {
		fmt.Fprintf(&extraAttrs, ` class="%s"`, html.EscapeString(class))
	}
	if id != "" {
		fmt.Fprintf(&extraAttrs, ` id="%s"`, html.EscapeString(id))
	}
	if style != "" {
		fmt.Fprintf(&extraAttrs, ` style="%s"`, html.EscapeString(style))
	}

	isBlack := func(c color.Color) bool {
		r, g, b, a := c.RGBA()
		if a == 0 {
			return false
		}
		// Relative luminance check
		luminance := (0.299*float64(r) + 0.587*float64(g) + 0.114*float64(b)) / 65535.0
		return luminance < 0.5
	}

	// 2D Matrix Barcode (DataMatrix or PDF417)
	if dy > 1 {
		if widthStr == "" {
			widthStr = "120px"
		} else if _, err := strconv.Atoi(widthStr); err == nil {
			widthStr = widthStr + "px"
		}
		if heightStr == "" {
			heightStr = "120px"
		} else if _, err := strconv.Atoi(heightStr); err == nil {
			heightStr = heightStr + "px"
		}

		var pathBuf strings.Builder
		for y := 0; y < dy; y++ {
			for x := 0; x < dx; x++ {
				if isBlack(bc.At(x, y)) {
					fmt.Fprintf(&pathBuf, "M%d,%dh1v1h-1z", x, y)
				}
			}
		}

		var bgRect string
		if strings.ToLower(bgColor) != "none" && strings.ToLower(bgColor) != "transparent" {
			bgRect = fmt.Sprintf(`<rect width="100%%" height="100%%" fill="%s"/>`, html.EscapeString(bgColor))
		}

		return fmt.Sprintf(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%s" height="%s" shape-rendering="crispEdges"%s>%s<path d="%s" fill="%s"/></svg>`,
			dx, dy, html.EscapeString(widthStr), html.EscapeString(heightStr), extraAttrs.String(), bgRect, pathBuf.String(), html.EscapeString(fgColor),
		), nil
	}

	// 1D Linear Barcode
	barHeight := 50
	totalHeight := barHeight
	var textElement string
	if showText {
		totalHeight = barHeight + 16
		textElement = fmt.Sprintf(
			`<text x="%.1f" y="%d" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace,sans-serif" font-size="11" fill="%s">%s</text>`,
			float64(dx)/2.0, barHeight+13, html.EscapeString(fgColor), html.EscapeString(value),
		)
	}

	if widthStr == "" {
		widthStr = fmt.Sprintf("%dpx", dx*2)
	} else if _, err := strconv.Atoi(widthStr); err == nil {
		widthStr = widthStr + "px"
	}
	if heightStr == "" {
		heightStr = fmt.Sprintf("%dpx", totalHeight)
	} else if _, err := strconv.Atoi(heightStr); err == nil {
		heightStr = heightStr + "px"
	}

	var barsBuf strings.Builder
	start := -1
	for x := 0; x < dx; x++ {
		if isBlack(bc.At(x, 0)) {
			if start == -1 {
				start = x
			}
		} else {
			if start != -1 {
				w := x - start
				fmt.Fprintf(&barsBuf, `<rect x="%d" y="0" width="%d" height="%d" fill="%s"/>`, start, w, barHeight, html.EscapeString(fgColor))
				start = -1
			}
		}
	}
	if start != -1 {
		w := dx - start
		fmt.Fprintf(&barsBuf, `<rect x="%d" y="0" width="%d" height="%d" fill="%s"/>`, start, w, barHeight, html.EscapeString(fgColor))
	}

	var bgRect string
	if strings.ToLower(bgColor) != "none" && strings.ToLower(bgColor) != "transparent" {
		bgRect = fmt.Sprintf(`<rect width="100%%" height="100%%" fill="%s"/>`, html.EscapeString(bgColor))
	}

	return fmt.Sprintf(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%s" height="%s"%s>%s%s%s</svg>`,
		dx, totalHeight, html.EscapeString(widthStr), html.EscapeString(heightStr), extraAttrs.String(), bgRect, barsBuf.String(), textElement,
	), nil
}

func barcodeErrorSVG(msg string) string {
	return fmt.Sprintf(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 32" width="240" height="32" style="border:1px solid #ef4444;border-radius:4px;"><rect width="100%%" height="100%%" fill="#fee2e2"/><text x="120" y="20" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="10" font-weight="600" fill="#b91c1c">Barcode Error: %s</text></svg>`,
		html.EscapeString(msg),
	)
}

func nodeAttr(n *nethtml.Node, key string) string {
	for _, attr := range n.Attr {
		if strings.EqualFold(attr.Key, key) {
			return strings.TrimSpace(attr.Val)
		}
	}
	return ""
}

// transformBarcodes scans HTML for <qrcode>, <qr-code>, <barcode>, data-qrcode,
// and data-barcode elements and converts them into inline resolution-independent vector SVGs.
func transformBarcodes(htmlStr string) string {
	// Fast-path exit
	if !strings.Contains(htmlStr, "<qrcode") &&
		!strings.Contains(htmlStr, "<qr-code") &&
		!strings.Contains(htmlStr, "<barcode") &&
		!strings.Contains(htmlStr, "data-qrcode") &&
		!strings.Contains(htmlStr, "data-barcode") {
		return htmlStr
	}

	doc, err := nethtml.Parse(strings.NewReader(htmlStr))
	if err != nil {
		return htmlStr
	}

	var replaceNodeWithSVG func(*nethtml.Node, string)
	replaceNodeWithSVG = func(n *nethtml.Node, svgContent string) {
		fragment, parseErr := nethtml.ParseFragment(strings.NewReader(svgContent), n.Parent)
		if parseErr != nil || len(fragment) == 0 {
			return
		}
		// Insert replacement before n
		for _, child := range fragment {
			n.Parent.InsertBefore(child, n)
		}
		// Remove n
		n.Parent.RemoveChild(n)
	}

	var walk func(*nethtml.Node)
	walk = func(n *nethtml.Node) {
		if n.Type == nethtml.ElementNode {
			tag := strings.ToLower(n.Data)
			if tag == "qrcode" || tag == "qr-code" {
				val := nodeAttr(n, "value")
				if val == "" && n.FirstChild != nil && n.FirstChild.Type == nethtml.TextNode {
					val = strings.TrimSpace(n.FirstChild.Data)
				}
				size := nodeAttr(n, "size")
				level := nodeAttr(n, "level")
				color := nodeAttr(n, "color")
				bg := nodeAttr(n, "background")
				class := nodeAttr(n, "class")
				id := nodeAttr(n, "id")
				style := nodeAttr(n, "style")

				svg, err := generateQRCodeSVG(val, size, level, color, bg, class, id, style)
				if err != nil {
					svg = barcodeErrorSVG(err.Error())
				}
				replaceNodeWithSVG(n, svg)
				return
			} else if tag == "barcode" {
				bType := nodeAttr(n, "type")
				val := nodeAttr(n, "value")
				if val == "" && n.FirstChild != nil && n.FirstChild.Type == nethtml.TextNode {
					val = strings.TrimSpace(n.FirstChild.Data)
				}
				width := nodeAttr(n, "width")
				height := nodeAttr(n, "height")
				textAttr := strings.ToLower(nodeAttr(n, "text"))
				showText := textAttr != "false" && textAttr != "0" && textAttr != "no"
				color := nodeAttr(n, "color")
				bg := nodeAttr(n, "background")
				class := nodeAttr(n, "class")
				id := nodeAttr(n, "id")
				style := nodeAttr(n, "style")

				svg, err := generateBarcodeSVG(bType, val, width, height, showText, color, bg, class, id, style)
				if err != nil {
					svg = barcodeErrorSVG(err.Error())
				}
				replaceNodeWithSVG(n, svg)
				return
			} else if dataQR := nodeAttr(n, "data-qrcode"); dataQR != "" {
				size := nodeAttr(n, "data-qr-size")
				level := nodeAttr(n, "data-qr-level")
				color := nodeAttr(n, "data-qr-color")
				bg := nodeAttr(n, "data-qr-background")
				class := nodeAttr(n, "class")
				id := nodeAttr(n, "id")
				style := nodeAttr(n, "style")

				svg, err := generateQRCodeSVG(dataQR, size, level, color, bg, class, id, style)
				if err != nil {
					svg = barcodeErrorSVG(err.Error())
				}
				replaceNodeWithSVG(n, svg)
				return
			} else if dataBC := nodeAttr(n, "data-barcode"); dataBC != "" {
				bType := nodeAttr(n, "data-barcode-type")
				width := nodeAttr(n, "data-barcode-width")
				height := nodeAttr(n, "data-barcode-height")
				textAttr := strings.ToLower(nodeAttr(n, "data-barcode-text"))
				showText := textAttr != "false" && textAttr != "0" && textAttr != "no"
				color := nodeAttr(n, "data-barcode-color")
				bg := nodeAttr(n, "data-barcode-background")
				class := nodeAttr(n, "class")
				id := nodeAttr(n, "id")
				style := nodeAttr(n, "style")

				svg, err := generateBarcodeSVG(bType, dataBC, width, height, showText, color, bg, class, id, style)
				if err != nil {
					svg = barcodeErrorSVG(err.Error())
				}
				replaceNodeWithSVG(n, svg)
				return
			} else if dataBCVal := nodeAttr(n, "data-barcode-value"); dataBCVal != "" {
				bType := nodeAttr(n, "data-barcode-type")
				width := nodeAttr(n, "data-barcode-width")
				height := nodeAttr(n, "data-barcode-height")
				textAttr := strings.ToLower(nodeAttr(n, "data-barcode-text"))
				showText := textAttr != "false" && textAttr != "0" && textAttr != "no"
				color := nodeAttr(n, "data-barcode-color")
				bg := nodeAttr(n, "data-barcode-background")
				class := nodeAttr(n, "class")
				id := nodeAttr(n, "id")
				style := nodeAttr(n, "style")

				svg, err := generateBarcodeSVG(bType, dataBCVal, width, height, showText, color, bg, class, id, style)
				if err != nil {
					svg = barcodeErrorSVG(err.Error())
				}
				replaceNodeWithSVG(n, svg)
				return
			}
		}

		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			walk(c)
			c = next
		}
	}

	walk(doc)

	var buf bytes.Buffer
	if err := nethtml.Render(&buf, doc); err != nil {
		return htmlStr
	}
	return buf.String()
}
