package main

import (
	"encoding/json"
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

func TestErrorResponseRetryableClassification(t *testing.T) {
	cases := []struct {
		status        int
		wantRetryable bool
		wantRetryHdr  bool
	}{
		{400, false, false},
		{401, false, false},
		{403, false, false},
		{404, false, false},
		{413, false, false},
		{422, false, false},
		{429, true, true},
		{503, true, true},
		{504, true, false},
	}
	for _, tc := range cases {
		headers := map[string]string{"X-Request-Id": "req-1"}
		resp := errorResponse(tc.status, "msg", headers)
		var body APIErrorResponse
		if err := json.Unmarshal([]byte(resp.Body), &body); err != nil {
			t.Fatalf("status %d decode failed: %v", tc.status, err)
		}
		if body.Retryable == nil || *body.Retryable != tc.wantRetryable {
			t.Fatalf("status %d retryable = %v, want %v", tc.status, body.Retryable, tc.wantRetryable)
		}
		if tc.wantRetryHdr && resp.Headers["Retry-After"] == "" {
			t.Fatalf("status %d expected Retry-After header, got %#v", tc.status, resp.Headers)
		}
	}
}

func TestUnknownFieldErrorExtractionAcrossRequestParsers(t *testing.T) {
	t.Run("render request", func(t *testing.T) {
		_, err := normalizeCanonicalRenderRequest(`{"version":"1","source":{"type":"html","content":"<p>hi</p>"},"unknownOpt":1}`)
		resp := renderErrorResponse(err, map[string]string{"X-Request-Id": "req-render"})
		var body APIErrorResponse
		if decErr := json.Unmarshal([]byte(resp.Body), &body); decErr != nil {
			t.Fatal(decErr)
		}
		if resp.StatusCode != 400 || body.Field != "unknownOpt" || !strings.Contains(body.Error, "unknownOpt") || body.Retryable == nil || *body.Retryable {
			t.Fatalf("unexpected render unknown field response: status=%d body=%#v", resp.StatusCode, body)
		}
	})

	t.Run("document request", func(t *testing.T) {
		_, err := parseDocumentRenderRequest(`{"version":"1","html":"<p>hi</p>","data":{},"badField":true}`)
		resp := renderErrorResponse(err, map[string]string{"X-Request-Id": "req-doc"})
		var body APIErrorResponse
		if decErr := json.Unmarshal([]byte(resp.Body), &body); decErr != nil {
			t.Fatal(decErr)
		}
		if resp.StatusCode != 400 || body.Field != "badField" || !strings.Contains(body.Error, "badField") {
			t.Fatalf("unexpected document unknown field response: status=%d body=%#v", resp.StatusCode, body)
		}
	})

	t.Run("batch request", func(t *testing.T) {
		_, err := parseBatchRenderRequest(`{"version":"1","items":[{"definition":{"version":"1","source":{"type":"html","content":"<p>hi</p>"}}}],"bogusKey":123}`)
		resp := renderErrorResponse(err, map[string]string{"X-Request-Id": "req-batch"})
		var body APIErrorResponse
		if decErr := json.Unmarshal([]byte(resp.Body), &body); decErr != nil {
			t.Fatal(decErr)
		}
		if resp.StatusCode != 400 || body.Field != "bogusKey" || !strings.Contains(body.Error, "bogusKey") {
			t.Fatalf("unexpected batch unknown field response: status=%d body=%#v", resp.StatusCode, body)
		}
	})

	t.Run("merge request", func(t *testing.T) {
		_, err := parseMergeRequest(`{"files":["file_1","file_2"],"extraProp":true}`)
		resp := renderErrorResponse(err, map[string]string{"X-Request-Id": "req-merge"})
		var body APIErrorResponse
		if decErr := json.Unmarshal([]byte(resp.Body), &body); decErr != nil {
			t.Fatal(decErr)
		}
		if resp.StatusCode != 400 || body.Field != "extraProp" || !strings.Contains(body.Error, "extraProp") {
			t.Fatalf("unexpected merge unknown field response: status=%d body=%#v", resp.StatusCode, body)
		}
	})
}
