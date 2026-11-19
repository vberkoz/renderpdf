package main

import (
	"strings"
	"testing"
)

func TestJSONResponseDoesNotEscapeAmpersandInURLs(t *testing.T) {
	presignedURL := "https://renderpdf-pdfs-653268860643.s3.amazonaws.com/files/trial/test.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAZQGO3X3RR6GUC23D%2F20261111%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261111T190422Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=aba1739377f52d67ba4ca1b91b8ae6454110894e4684be7a8d3288800431fbe4"
	resp := Response{
		RequestID: "1d4ff18e-9b2b-4030-8e3a-f204016a8562",
		URL:       presignedURL,
		Size:      35930,
	}

	res := jsonResponse(200, resp, map[string]string{"Content-Type": "application/json"})
	if strings.Contains(res.Body, `\u0026`) {
		t.Fatalf("expected JSON body to contain literal '&', but found escaped '\\u0026': %s", res.Body)
	}
	if !strings.Contains(res.Body, presignedURL) {
		t.Fatalf("expected JSON body to contain exact URL %q, got: %s", presignedURL, res.Body)
	}
}

func TestMarshalJSONWithoutEscapePreservesHTMLCharacters(t *testing.T) {
	input := map[string]string{
		"query": "a=1&b=2<tag>&c=3",
	}
	bytes, err := marshalJSONWithoutEscape(input)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	raw := string(bytes)
	if strings.Contains(raw, `\u0026`) || strings.Contains(raw, `\u003c`) || strings.Contains(raw, `\u003e`) {
		t.Fatalf("expected unescaped characters, got: %s", raw)
	}
	if !strings.Contains(raw, `"query":"a=1&b=2<tag>&c=3"`) {
		t.Fatalf("unexpected output: %s", raw)
	}
}
