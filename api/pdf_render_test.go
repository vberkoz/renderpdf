package main

import (
	"bytes"
	"io"
	"math"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

func TestResolveCDPPrintMargins(t *testing.T) {
	// When displayHeaderFooter is false, margins should be 0 so CSS @page margins take full control
	top, bottom, left, right := resolveCDPPrintMargins(false, "18mm")
	if top != 0 || bottom != 0 || left != 0 || right != 0 {
		t.Fatalf("expected 0 margins when displayHeaderFooter is false, got top=%v, bottom=%v, left=%v, right=%v", top, bottom, left, right)
	}

	// When displayHeaderFooter is true and margin is empty, default 0.5in is used
	top, bottom, left, right = resolveCDPPrintMargins(true, "")
	if top != 0.5 || bottom != 0.5 || left != 0.5 || right != 0.5 {
		t.Fatalf("expected 0.5 margins with empty marginStr, got top=%v, bottom=%v, left=%v, right=%v", top, bottom, left, right)
	}

	// When displayHeaderFooter is true and margin is small (e.g. 0mm), floor of 0.35in is enforced on top and bottom
	top, bottom, left, right = resolveCDPPrintMargins(true, "0mm")
	if top != 0.35 || bottom != 0.35 {
		t.Fatalf("expected floor 0.35 for top/bottom with 0mm, got top=%v, bottom=%v", top, bottom)
	}
	if left != 0 || right != 0 {
		t.Fatalf("expected 0 for left/right with 0mm, got left=%v, right=%v", left, right)
	}

	// When displayHeaderFooter is true and margin is 1.5in
	top, bottom, left, right = resolveCDPPrintMargins(true, "1.5in")
	if top != 1.5 || bottom != 1.5 || left != 1.5 || right != 1.5 {
		t.Fatalf("expected 1.5 margins, got top=%v, bottom=%v, left=%v, right=%v", top, bottom, left, right)
	}
}

func TestNormalizeHeaderFooterTemplate(t *testing.T) {
	// Empty template becomes minimal valid HTML span
	if got := normalizeHeaderFooterTemplate(""); got != "<span></span>" {
		t.Fatalf("expected <span></span>, got %q", got)
	}
	if got := normalizeHeaderFooterTemplate("   "); got != "<span></span>" {
		t.Fatalf("expected <span></span>, got %q", got)
	}

	// Template without font-size gets wrapped in div with explicit font-size and styling
	tmpl := `<span class="pageNumber"></span>`
	got := normalizeHeaderFooterTemplate(tmpl)
	if !bytes.Contains([]byte(got), []byte("font-size:10px")) {
		t.Fatalf("expected font-size injection, got %q", got)
	}
	if !bytes.Contains([]byte(got), []byte(tmpl)) {
		t.Fatalf("expected inner template preserved, got %q", got)
	}

	// Template with existing font-size is preserved as-is
	custom := `<div style="font-size:12px; color:red;">Header</div>`
	if got := normalizeHeaderFooterTemplate(custom); got != custom {
		t.Fatalf("expected %q, got %q", custom, got)
	}
}

func TestApplyPDFPageNumbers(t *testing.T) {
	orig := []byte(minimalValidPDF)

	// When options.PageNumbers is nil, original bytes are returned unmodified
	out, err := applyPDFPageNumbers(orig, documentRenderOptions{})
	if err != nil {
		t.Fatalf("applyPDFPageNumbers error: %v", err)
	}
	if !bytes.Equal(orig, out) {
		t.Fatalf("expected unmodified bytes when PageNumbers is nil")
	}

	// Stamping page numbers on 1-page document
	opts := documentRenderOptions{
		PageNumbers: &pageNumberOptions{
			Format:   "Page {page} of {total}",
			Position: "bottom-center",
			FontSize: 9,
		},
	}
	stamped, err := applyPDFPageNumbers(orig, opts)
	if err != nil {
		t.Fatalf("applyPDFPageNumbers failed: %v", err)
	}
	if bytes.Equal(orig, stamped) {
		t.Fatalf("expected stamped bytes to differ from original")
	}

	// Validate stamped PDF with pdfcpu
	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	if err := api.Validate(bytes.NewReader(stamped), conf); err != nil {
		t.Fatalf("stamped PDF validation failed: %v", err)
	}

	pageCount, err := api.PageCount(bytes.NewReader(stamped), conf)
	if err != nil {
		t.Fatalf("reading page count: %v", err)
	}
	if pageCount != 1 {
		t.Fatalf("expected 1 page, got %d", pageCount)
	}

	// Stamping page numbers on multi-page document with ExcludeCover, StartPage, and custom styling
	var twoPageBuf bytes.Buffer
	if err := api.MergeRaw([]io.ReadSeeker{bytes.NewReader(orig), bytes.NewReader(orig)}, &twoPageBuf, false, conf); err != nil {
		t.Fatalf("merge failed: %v", err)
	}
	twoPagePDF := twoPageBuf.Bytes()

	multiOpts := documentRenderOptions{
		PageNumbers: &pageNumberOptions{
			Format:       "Page {page} of {total}",
			Position:     "bottom-right",
			StartPage:    2,
			ExcludeCover: true,
			StartNumber:  1,
			FontSize:     8,
			Color:        "0.2 0.2 0.2",
		},
	}
	multiStamped, err := applyPDFPageNumbers(twoPagePDF, multiOpts)
	if err != nil {
		t.Fatalf("applyPDFPageNumbers multi-page failed: %v", err)
	}
	if err := api.Validate(bytes.NewReader(multiStamped), conf); err != nil {
		t.Fatalf("multi-page stamped validation failed: %v", err)
	}
	cnt, err := api.PageCount(bytes.NewReader(multiStamped), conf)
	if err != nil || cnt != 2 {
		t.Fatalf("expected 2 pages, got %d (err: %v)", cnt, err)
	}
}

func TestResolveDisplayHeaderFooter(t *testing.T) {
	trueVal := true
	falseVal := false

	t.Setenv("DEFAULT_DISPLAY_HEADER_FOOTER", "")
	if got := resolveDisplayHeaderFooter("<p>Hello</p>", documentRenderOptions{}); got != false {
		t.Fatalf("default resolveDisplayHeaderFooter = %v, want false", got)
	}
	if got := resolveDisplayHeaderFooter("<p>Hello</p>", documentRenderOptions{DisplayHeaderFooter: &trueVal}); got != true {
		t.Fatalf("explicit true = %v, want true", got)
	}
	if got := resolveDisplayHeaderFooter("<p>Hello</p>", documentRenderOptions{DisplayHeaderFooter: &falseVal, HeaderTemplate: "<div>H</div>"}); got != false {
		t.Fatalf("explicit false with headerTemplate = %v, want false", got)
	}
	if got := resolveDisplayHeaderFooter("<p>Hello</p>", documentRenderOptions{HeaderTemplate: "<div>Header</div>"}); got != true {
		t.Fatalf("custom headerTemplate = %v, want true", got)
	}
	if got := resolveDisplayHeaderFooter("<p>Hello</p>", documentRenderOptions{FooterTemplate: "<div>Footer</div>"}); got != true {
		t.Fatalf("custom footerTemplate = %v, want true", got)
	}
	if got := resolveDisplayHeaderFooter("<p>Hello</p>", documentRenderOptions{PageNumbers: &pageNumberOptions{Format: "{page}"}}); got != false {
		t.Fatalf("pageNumbers set = %v, want false", got)
	}
	if got := resolveDisplayHeaderFooter("<!-- RenderPDF:no-header-footer --><p>Hello</p>", documentRenderOptions{}); got != false {
		t.Fatalf("marker present = %v, want false", got)
	}

	t.Setenv("DEFAULT_DISPLAY_HEADER_FOOTER", "true")
	if got := resolveDisplayHeaderFooter("<p>Hello</p>", documentRenderOptions{}); got != true {
		t.Fatalf("env flag true default = %v, want true", got)
	}
	if got := resolveDisplayHeaderFooter("<p>Hello</p>", documentRenderOptions{DisplayHeaderFooter: &falseVal}); got != false {
		t.Fatalf("env flag true with explicit false = %v, want false", got)
	}
	if got := resolveDisplayHeaderFooter("<p>Hello</p>", documentRenderOptions{PageNumbers: &pageNumberOptions{Format: "{page}"}}); got != false {
		t.Fatalf("env flag true with pageNumbers = %v, want false", got)
	}
	if got := resolveDisplayHeaderFooter("<!-- renderpdf:no-header-footer --><p>Hello</p>", documentRenderOptions{}); got != false {
		t.Fatalf("env flag true with marker = %v, want false", got)
	}
}

func TestBuildCDPPrintParamsAcrossLayouts(t *testing.T) {
	trueVal := true
	approxEq := func(a, b float64) bool { return math.Abs(a-b) < 1e-4 }

	// 1. cssPageOwnsLayout=true (document/markdown): PreferCSSPageSize=true and zero CDP margins when displayHeaderFooter=false
	docParams := buildCDPPrintParams(false, "", "", true, documentRenderOptions{
		Format:    "Letter",
		Margin:    "1in",
		Landscape: &trueVal,
	})
	if !docParams.PrintBackground || docParams.DisplayHeaderFooter || !docParams.PreferCSSPageSize || !docParams.Landscape {
		t.Fatalf("unexpected docParams flags: %#v", docParams)
	}
	if !approxEq(docParams.PaperWidth, 8.5) || !approxEq(docParams.PaperHeight, 11.0) {
		t.Fatalf("Letter dimensions = (%v, %v), want (8.5, 11.0)", docParams.PaperWidth, docParams.PaperHeight)
	}
	if docParams.MarginTop != 0 || docParams.MarginBottom != 0 || docParams.MarginLeft != 0 || docParams.MarginRight != 0 {
		t.Fatalf("expected 0 CDP margins for cssPageOwnsLayout without header/footer, got (%v,%v,%v,%v)",
			docParams.MarginTop, docParams.MarginBottom, docParams.MarginLeft, docParams.MarginRight)
	}

	// 2. cssPageOwnsLayout=true with displayHeaderFooter=true enforces 0.35in floor & passes templates
	docHeaderParams := buildCDPPrintParams(true, "<div>H</div>", "<div>F</div>", true, documentRenderOptions{
		Format: "Legal",
		Margin: "0mm",
	})
	if !docHeaderParams.PreferCSSPageSize || !docHeaderParams.DisplayHeaderFooter {
		t.Fatalf("unexpected docHeaderParams flags: %#v", docHeaderParams)
	}
	if !approxEq(docHeaderParams.PaperWidth, 8.5) || !approxEq(docHeaderParams.PaperHeight, 14.0) {
		t.Fatalf("Legal dimensions = (%v, %v), want (8.5, 14.0)", docHeaderParams.PaperWidth, docHeaderParams.PaperHeight)
	}
	if !approxEq(docHeaderParams.MarginTop, 0.35) || !approxEq(docHeaderParams.MarginBottom, 0.35) || docHeaderParams.MarginLeft != 0 || docHeaderParams.MarginRight != 0 {
		t.Fatalf("expected 0.35 floor on top/bottom, got (%v,%v,%v,%v)",
			docHeaderParams.MarginTop, docHeaderParams.MarginBottom, docHeaderParams.MarginLeft, docHeaderParams.MarginRight)
	}
	if docHeaderParams.HeaderTemplate != "<div>H</div>" || docHeaderParams.FooterTemplate != "<div>F</div>" {
		t.Fatalf("unexpected header/footer templates: %q / %q", docHeaderParams.HeaderTemplate, docHeaderParams.FooterTemplate)
	}

	// 3. cssPageOwnsLayout=false (html/template/url/upload) with NO page options keeps PreferCSSPageSize=true and A4 defaults
	plainDefault := buildCDPPrintParams(false, "", "", false, documentRenderOptions{})
	if !plainDefault.PreferCSSPageSize || plainDefault.Landscape {
		t.Fatalf("expected PreferCSSPageSize=true and Landscape=false when no page options, got %#v", plainDefault)
	}
	if !approxEq(plainDefault.PaperWidth, 210.0/25.4) || !approxEq(plainDefault.PaperHeight, 297.0/25.4) {
		t.Fatalf("A4 dimensions = (%v, %v)", plainDefault.PaperWidth, plainDefault.PaperHeight)
	}

	// 4. cssPageOwnsLayout=false WITH explicit format/margin/landscape disables PreferCSSPageSize and sets direct CDP margins
	plainLetter := buildCDPPrintParams(false, "", "", false, documentRenderOptions{
		Format:    "Letter",
		Margin:    "18mm",
		Landscape: &trueVal,
	})
	if plainLetter.PreferCSSPageSize {
		t.Fatalf("expected PreferCSSPageSize=false when caller provides explicit page options")
	}
	if !plainLetter.Landscape || !approxEq(plainLetter.PaperWidth, 8.5) || !approxEq(plainLetter.PaperHeight, 11.0) {
		t.Fatalf("unexpected Letter landscape params: %#v", plainLetter)
	}
	want18mm := 18.0 / 25.4
	if !approxEq(plainLetter.MarginTop, want18mm) || !approxEq(plainLetter.MarginBottom, want18mm) || !approxEq(plainLetter.MarginLeft, want18mm) || !approxEq(plainLetter.MarginRight, want18mm) {
		t.Fatalf("expected 18mm (%v in) margins, got (%v,%v,%v,%v)", want18mm,
			plainLetter.MarginTop, plainLetter.MarginBottom, plainLetter.MarginLeft, plainLetter.MarginRight)
	}

	// 5. cssPageOwnsLayout=false with 0mm margin & displayHeaderFooter=false sets 0 margins cleanly
	zeroMargin := buildCDPPrintParams(false, "", "", false, documentRenderOptions{Margin: "0mm"})
	if zeroMargin.PreferCSSPageSize || zeroMargin.MarginTop != 0 || zeroMargin.MarginBottom != 0 {
		t.Fatalf("expected 0 margins and PreferCSSPageSize=false for 0mm, got %#v", zeroMargin)
	}
	oneInch := buildCDPPrintParams(false, "", "", false, documentRenderOptions{Margin: "1in"})
	if !approxEq(oneInch.MarginTop, 1.0) || !approxEq(oneInch.MarginRight, 1.0) {
		t.Fatalf("expected 1in margins, got %#v", oneInch)
	}
}

