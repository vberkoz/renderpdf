package main

import "testing"

func TestCleanPackagePath(t *testing.T) {
	tests := []struct {
		input string
		want  string
		valid bool
	}{
		{"index.html", "index.html", true},
		{"assets/../style.css", "style.css", true},
		{"assets\\site.css", "assets/site.css", true},
		{"../secret.html", "", false},
		{"/etc/passwd", "", false},
	}
	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			got, err := cleanPackagePath(test.input)
			if (err == nil) != test.valid || got != test.want {
				t.Fatalf("cleanPackagePath(%q) = %q, %v; want %q, valid=%v", test.input, got, err, test.want, test.valid)
			}
		})
	}
}

func TestPackageObjectKeyDoesNotExposeOwner(t *testing.T) {
	key := packageObjectKey("customer@example.com", "123e4567-e89b-12d3-a456-426614174000")
	if key == "" || key == "uploads/customer@example.com/123e4567-e89b-12d3-a456-426614174000.zip" {
		t.Fatalf("package key exposed owner: %q", key)
	}
}
