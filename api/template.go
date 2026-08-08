package main

import (
	"fmt"
	stdhtml "html"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Template is the durable representation of a customer-owned HTML document
// template. Storage and HTTP endpoints will be added separately; keeping the
// model here lets those layers share one contract.
type Template struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Type      TemplateType `json:"type"`
	HTML      string       `json:"html"`
	OwnerID   string       `json:"ownerId"`
	CreatedAt time.Time    `json:"createdAt"`
	UpdatedAt time.Time    `json:"updatedAt"`
	Version   int          `json:"version"`
}

// TemplateType classifies the supplied starter templates. Custom leaves room
// for customer-created document types without changing the persisted schema.
type TemplateType string

const (
	TemplateTypeInvoice     TemplateType = "invoice"
	TemplateTypeContract    TemplateType = "contract"
	TemplateTypeCertificate TemplateType = "certificate"
	TemplateTypeReceipt     TemplateType = "receipt"
	TemplateTypeCustom      TemplateType = "custom"
)

const (
	missingTemplateVariableCode = "template_variable_missing"
	unknownTemplateVariableCode = "template_variable_unknown"
	invalidTemplateVariableCode = "template_variable_invalid"
)

// Placeholders are {{path.to.value}}, where every path segment starts with a
// letter or underscore and can then contain letters, digits, or underscores.
// Values are HTML-escaped before insertion. Raw HTML interpolation is not
// supported by this contract.
var (
	templatePathSegmentPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	templatePlaceholderPattern = regexp.MustCompile(`{{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*}}`)
)

// renderTemplateHTML applies a template's declared placeholders to a nested
// variables object. Every placeholder must be supplied, and every supplied
// leaf value must be consumed. Both conditions deliberately fail with a 422
// renderError so callers receive an actionable API response.
func renderTemplateHTML(templateHTML string, variables map[string]any) (string, error) {
	matches := templatePlaceholderPattern.FindAllStringSubmatchIndex(templateHTML, -1)
	if strings.Contains(templateHTML, "{{") || strings.Contains(templateHTML, "}}") {
		matched := 0
		for _, match := range matches {
			matched += strings.Count(templateHTML[match[0]:match[1]], "{{")
		}
		if matched != strings.Count(templateHTML, "{{") || matched != strings.Count(templateHTML, "}}") {
			return "", templateVariableError(invalidTemplateVariableCode, "Template contains an invalid placeholder; use {{path.to.value}}")
		}
	}

	values, err := flattenTemplateVariables(variables, "")
	if err != nil {
		return "", err
	}

	expected := make(map[string]struct{}, len(matches))
	for _, match := range matches {
		expected[templateHTML[match[2]:match[3]]] = struct{}{}
	}
	for path := range expected {
		if _, ok := values[path]; !ok {
			return "", templateVariableError(missingTemplateVariableCode, fmt.Sprintf("Missing required template variable %q", path))
		}
	}
	for path := range values {
		if _, ok := expected[path]; !ok {
			return "", templateVariableError(unknownTemplateVariableCode, fmt.Sprintf("Unknown template variable %q", path))
		}
	}

	return templatePlaceholderPattern.ReplaceAllStringFunc(templateHTML, func(placeholder string) string {
		path := templatePlaceholderPattern.FindStringSubmatch(placeholder)[1]
		return stdhtml.EscapeString(fmt.Sprint(values[path]))
	}), nil
}

func flattenTemplateVariables(variables map[string]any, prefix string) (map[string]any, error) {
	values := make(map[string]any)
	for key, value := range variables {
		if !templatePathSegment(key) {
			return nil, templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Invalid template variable name %q", key))
		}
		path := key
		if prefix != "" {
			path = prefix + "." + key
		}
		if nested, ok := value.(map[string]any); ok {
			nestedValues, err := flattenTemplateVariables(nested, path)
			if err != nil {
				return nil, err
			}
			for nestedPath, nestedValue := range nestedValues {
				values[nestedPath] = nestedValue
			}
			continue
		}
		if value == nil {
			return nil, templateVariableError(missingTemplateVariableCode, fmt.Sprintf("Missing required template variable %q", path))
		}
		values[path] = value
	}
	return values, nil
}

func templatePathSegment(segment string) bool {
	return templatePathSegmentPattern.MatchString(segment)
}

func templateVariableError(code, message string) *renderError {
	return &renderError{Code: code, Message: message, Status: 422}
}

// templateVariablePaths returns sorted paths for use by future template API
// responses and documentation without exposing the parser's implementation.
func templateVariablePaths(templateHTML string) []string {
	seen := map[string]struct{}{}
	for _, match := range templatePlaceholderPattern.FindAllStringSubmatch(templateHTML, -1) {
		seen[match[1]] = struct{}{}
	}
	paths := make([]string, 0, len(seen))
	for path := range seen {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}
