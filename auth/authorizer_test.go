//go:build authorizer

package main

import "testing"

func TestHeaderValueIsCaseInsensitive(t *testing.T) {
	tests := []struct {
		name    string
		headers map[string]string
		want    string
	}{
		{name: "lowercase", headers: map[string]string{"x-api-key": "lower"}, want: "lower"},
		{name: "canonical", headers: map[string]string{"X-Api-Key": "canonical"}, want: "canonical"},
		{name: "uppercase", headers: map[string]string{"X-API-KEY": "upper"}, want: "upper"},
		{name: "missing", headers: map[string]string{"Content-Type": "application/json"}, want: ""},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := headerValue(test.headers, "x-api-key"); got != test.want {
				t.Fatalf("headerValue() = %q, want %q", got, test.want)
			}
		})
	}
}
