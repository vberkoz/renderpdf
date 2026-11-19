package main

import (
	"strings"
	"testing"
)

func TestGenerateQRCodeSVG(t *testing.T) {
	svg, err := generateQRCodeSVG("https://renderpdf.vberkoz.com", "150px", "H", "#1d4ed8", "#f0fdf4", "my-qr", "qr-id", "margin:10px")
	if err != nil {
		t.Fatalf("generateQRCodeSVG failed: %v", err)
	}

	if !strings.HasPrefix(svg, "<svg") || !strings.HasSuffix(svg, "</svg>") {
		t.Fatalf("expected valid SVG wrapper, got: %s", svg)
	}
	if !strings.Contains(svg, `viewBox="0 0`) {
		t.Errorf("expected viewBox attribute in SVG")
	}
	if !strings.Contains(svg, `width="150px"`) || !strings.Contains(svg, `height="150px"`) {
		t.Errorf("expected width and height 150px")
	}
	if !strings.Contains(svg, `class="my-qr"`) {
		t.Errorf("expected class attribute preserved")
	}
	if !strings.Contains(svg, `id="qr-id"`) {
		t.Errorf("expected id attribute preserved")
	}
	if !strings.Contains(svg, `fill="#1d4ed8"`) {
		t.Errorf("expected foreground color #1d4ed8")
	}
	if !strings.Contains(svg, `fill="#f0fdf4"`) {
		t.Errorf("expected background color #f0fdf4")
	}
	if !strings.Contains(svg, `shape-rendering="crispEdges"`) {
		t.Errorf("expected crispEdges rendering for QR code")
	}
}

func TestGenerateQRCodeSVGEmptyValue(t *testing.T) {
	_, err := generateQRCodeSVG("", "100px", "M", "", "", "", "", "")
	if err == nil {
		t.Errorf("expected error for empty QR code value")
	}
}

func TestGenerateBarcodeSVG1D(t *testing.T) {
	types := []string{"code128", "code39", "2of5"}
	for _, bType := range types {
		val := "123456"
		svg, err := generateBarcodeSVG(bType, val, "200px", "60px", true, "#000000", "#ffffff", "barcode-cls", "", "")
		if err != nil {
			t.Fatalf("generateBarcodeSVG(%s) failed: %v", bType, err)
		}
		if !strings.HasPrefix(svg, "<svg") || !strings.HasSuffix(svg, "</svg>") {
			t.Fatalf("expected valid SVG for %s", bType)
		}
		if !strings.Contains(svg, `class="barcode-cls"`) {
			t.Errorf("expected class preserved for %s", bType)
		}
		if !strings.Contains(svg, val) {
			t.Errorf("expected human-readable text %q in SVG for %s", val, bType)
		}
	}
}

func TestGenerateBarcodeSVG2D(t *testing.T) {
	types := []string{"datamatrix", "pdf417"}
	for _, bType := range types {
		val := "RENDERPDF-2D"
		svg, err := generateBarcodeSVG(bType, val, "100px", "100px", false, "#000000", "none", "", "", "")
		if err != nil {
			t.Fatalf("generateBarcodeSVG(%s) failed: %v", bType, err)
		}
		if !strings.HasPrefix(svg, "<svg") || !strings.HasSuffix(svg, "</svg>") {
			t.Fatalf("expected valid SVG for %s", bType)
		}
		if !strings.Contains(svg, `<path d="M`) {
			t.Errorf("expected matrix path for %s", bType)
		}
	}
}

func TestGenerateBarcodeSVGUnsupportedType(t *testing.T) {
	_, err := generateBarcodeSVG("unknown-type", "123", "", "", false, "", "", "", "", "")
	if err == nil {
		t.Errorf("expected error for unsupported barcode type")
	}
}

func TestTransformBarcodesInHTML(t *testing.T) {
	// Fast path test
	noBarcodes := "<html><body><h1>Hello World</h1><p>No barcodes here.</p></body></html>"
	if got := transformBarcodes(noBarcodes); got != noBarcodes {
		t.Errorf("expected fast path to return identical string")
	}

	// QR code tag transformation
	inputHTML := `<!doctype html>
<html>
<body>
  <div class="card">
    <qrcode value="https://example.com/verify" size="140" level="H" class="ticket-qr"></qrcode>
    <barcode type="code128" value="TICKET-2026-X" width="220" height="50" text="true"></barcode>
  </div>
</body>
</html>`

	transformed := transformBarcodes(inputHTML)
	if strings.Contains(transformed, "<qrcode") {
		t.Errorf("expected <qrcode> tag to be replaced with SVG")
	}
	if strings.Contains(transformed, "<barcode") {
		t.Errorf("expected <barcode> tag to be replaced with SVG")
	}
	if !strings.Contains(transformed, "ticket-qr") {
		t.Errorf("expected ticket-qr class in transformed SVG")
	}
	if !strings.Contains(transformed, "TICKET-2026-X") {
		t.Errorf("expected barcode text in transformed SVG")
	}
	if !strings.Contains(transformed, "<svg") {
		t.Errorf("expected SVG in transformed output")
	}
}

func TestTransformBarcodesDataAttributes(t *testing.T) {
	inputHTML := `<div>
    <div data-qrcode="https://example.com/data-attr" data-qr-size="90px"></div>
    <div data-barcode="PKG-7890" data-barcode-type="code128"></div>
  </div>`

	transformed := transformBarcodes(inputHTML)
	if strings.Contains(transformed, "data-qrcode=") {
		t.Errorf("expected data-qrcode to be replaced by SVG")
	}
	if strings.Contains(transformed, "data-barcode=") {
		t.Errorf("expected data-barcode to be replaced by SVG")
	}
	if !strings.Contains(transformed, "<svg") {
		t.Errorf("expected generated SVGs")
	}
}

func TestTransformBarcodesErrorHandling(t *testing.T) {
	// Invalid value for EAN (requires valid numeric string)
	inputHTML := `<barcode type="ean" value="NOT_NUMBERS"></barcode>`
	transformed := transformBarcodes(inputHTML)
	if !strings.Contains(transformed, "Barcode Error:") {
		t.Errorf("expected error SVG badge, got: %s", transformed)
	}
}
