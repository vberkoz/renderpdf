package main

import (
	"strings"
	"testing"
)

func TestInjectPrintCSS(t *testing.T) {
	inputWithHead := "<!doctype html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>"
	output := injectPrintCSS(inputWithHead)

	if !strings.Contains(output, "__RENDERPDF_INJECTED__") {
		t.Fatalf("expected injected marker in output, got: %s", output)
	}
	if !strings.Contains(output, "break-inside: avoid !important;") {
		t.Fatalf("expected break-inside avoidance in output, got: %s", output)
	}
	if !strings.Contains(output, "break-after: avoid !important;") {
		t.Fatalf("expected heading break-after avoidance in output, got: %s", output)
	}
	if !strings.Contains(output, ".signature") || !strings.Contains(output, ".totals-area") || !strings.Contains(output, ".avoid-break") {
		t.Fatalf("expected class selectors for signature, totals, and avoid-break in output, got: %s", output)
	}
	if !strings.Contains(output, "table-header-group !important;") {
		t.Fatalf("expected thead repeating headers in output, got: %s", output)
	}

	// Idempotency: second pass must not double-inject
	doubleOutput := injectPrintCSS(output)
	if strings.Count(doubleOutput, "__RENDERPDF_INJECTED__") != 1 {
		t.Fatalf("expected exactly 1 injection marker, got %d", strings.Count(doubleOutput, "__RENDERPDF_INJECTED__"))
	}

	// Input without head tag should prepend
	inputNoHead := "<div>Plain Fragment</div>"
	noHeadOutput := injectPrintCSS(inputNoHead)
	if !strings.HasPrefix(noHeadOutput, "<!-- __RENDERPDF_INJECTED__ -->") {
		t.Fatalf("expected prepended CSS when head is absent, got: %s", noHeadOutput)
	}
}

func TestInjectPrintCSSAllowsTbodyPagination(t *testing.T) {
	output := injectPrintCSS("<html><head></head><body><table><thead><tr><th>H</th></tr></thead><tbody><tr><td>R</td></tr></tbody></table></body></html>")
	start := strings.Index(output, `<style id="__lambda_print_fix__">`)
	end := strings.Index(output, `</style>`)
	if start < 0 || end <= start {
		t.Fatalf("missing injected style block in output: %s", output)
	}
	styleBlock := output[start:end]
	if !strings.Contains(styleBlock, "tr,") {
		t.Fatalf("expected tr selector in break-inside rule, got: %s", styleBlock)
	}
	if strings.Contains(styleBlock, "tbody") {
		t.Fatalf("tbody must not appear in injected print CSS break-inside rules, got: %s", styleBlock)
	}
}

func TestEnsureColgroupIsSafeNoOp(t *testing.T) {
	threeColTable := `<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>`
	result := ensureColgroup(threeColTable)

	// ensureColgroup must not blindly inject 4-column colgroup (40/20/20/20)
	if strings.Contains(result, `<col style="width:40%">`) {
		t.Fatalf("ensureColgroup should not inject hardcoded 4-column colgroup into 3-column table: %s", result)
	}
	if result != threeColTable {
		t.Fatalf("expected unaltered table, got: %s", result)
	}
}

func TestRewriteTfoot(t *testing.T) {
	input := `<table><thead><tr><th>Header</th></tr></thead><tfoot><tr><td>Footer</td></tr></tfoot><tbody><tr><td>Body</td></tr></tbody></table>`
	output := rewriteTfoot(input)

	if strings.Contains(strings.ToLower(output), "<tfoot") {
		t.Fatalf("expected tfoot to be rewritten, got: %s", output)
	}
	if !strings.Contains(output, "<tbody><tr><td>Footer</td></tr></tbody>") && !strings.Contains(output, "tbody") {
		t.Fatalf("expected tfoot to become tbody, got: %s", output)
	}
}
