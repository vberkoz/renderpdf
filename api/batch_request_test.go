package main

import "testing"

func TestParseBatchRenderRequestModes(t *testing.T) {
	shared := `{"version":"1","source":{"type":"stored","id":"src_123"},"items":[{"data":{"customer":{"name":"Ada"}}}]}`
	if _, err := parseBatchRenderRequest(shared); err != nil {
		t.Fatalf("shared source: %v", err)
	}
	explicit := `{"version":"1","items":[{"definition":{"version":"1","source":{"type":"markdown","content":"# Hi"},"data":{}}}]}`
	if _, err := parseBatchRenderRequest(explicit); err != nil {
		t.Fatalf("explicit definition: %v", err)
	}
}

func TestParseBatchRenderRequestRejectsMixedOrOversizedItems(t *testing.T) {
	if _, err := parseBatchRenderRequest(`{"version":"1","source":{"type":"stored","id":"src_123"},"items":[{"definition":{"version":"1","source":{"type":"html","content":"<p>x</p>"}}}]}`); err == nil {
		t.Fatal("expected mixed modes to fail")
	}
	items := ""
	for i := 0; i < maxBatchItemsPerJob+1; i++ {
		if i > 0 {
			items += ","
		}
		items += `{"data":{}}`
	}
	if _, err := parseBatchRenderRequest(`{"version":"1","source":{"type":"stored","id":"src_123"},"items":[` + items + `]}`); err == nil {
		t.Fatal("expected item cap to fail")
	}
}

func TestParseBatchRenderRequestRejectsOneHundredItems(t *testing.T) {
	items := ""
	for i := 0; i < 100; i++ {
		if i > 0 {
			items += ","
		}
		items += `{"data":{}}`
	}
	if _, err := parseBatchRenderRequest(`{"version":"1","source":{"type":"stored","id":"src_123"},"items":[` + items + `]}`); err == nil {
		t.Fatal("expected 100 items to be rejected because job plus items must fit one DynamoDB transaction")
	}
}
