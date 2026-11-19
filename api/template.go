package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Template is the durable representation of a customer-owned HTML document
// template. Storage and HTTP endpoints will be added separately; keeping the
// model here lets those layers share one contract.
type Template struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Type      TemplateType   `json:"type"`
	HTML      string         `json:"html"`
	Variables map[string]any `json:"variables,omitempty"`
	OwnerID   string         `json:"ownerId"`
	CreatedAt time.Time      `json:"createdAt"`
	UpdatedAt time.Time      `json:"updatedAt"`
	Version   int            `json:"version"`
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

// Placeholders are {{path.to.value}} or helpers like {{barcode '128' trackingId}}
// and {{qrcode url}}. Values in {{path.to.value}} are HTML-escaped before insertion;
// barcode and qrcode helpers render resolution-independent inline SVG vector graphics.
var (
	templatePathSegmentPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	templatePlaceholderPattern = regexp.MustCompile(`{{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*}}`)
	templateTagPattern         = regexp.MustCompile(`{{\s*([^}]+?)\s*}}`)
)

// renderTemplateHTML applies a template's declared placeholders, safe control blocks
// (#each, #if, #unless), and helpers to a nested variables object.
func renderTemplateHTML(templateHTML string, variables map[string]any) (string, error) {
	return renderTemplateHTMLWithOptions(templateHTML, variables, false)
}

func renderTemplateHTMLWithOptions(templateHTML string, variables map[string]any, allowExtra bool) (string, error) {
	return renderTemplateWithOptions(templateHTML, variables, allowExtra, defaultTemplateEscape)
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
	matches := templateTagPattern.FindAllStringSubmatch(templateHTML, -1)
	for _, match := range matches {
		inner := strings.TrimSpace(match[1])
		if inner == "" || inner == "else" || strings.HasPrefix(inner, "/") {
			continue
		}
		for _, prefix := range []string{"#each", "#if", "#unless"} {
			if strings.HasPrefix(inner, prefix+" ") || strings.HasPrefix(inner, prefix+"\t") {
				expr := strings.TrimSpace(inner[len(prefix):])
				if templatePlaceholderPattern.MatchString("{{"+expr+"}}") && expr != "this" {
					seen[expr] = struct{}{}
				}
				inner = ""
				break
			}
		}
		if inner == "" || strings.HasPrefix(inner, "#") {
			continue
		}
		if inner == "this" || inner == "." || strings.HasPrefix(inner, "@") || strings.HasPrefix(inner, "this.") || strings.HasPrefix(inner, "./") || strings.HasPrefix(inner, "../") {
			continue
		}
		tag, err := parseTemplateTag(match[1])
		if err != nil {
			continue
		}
		if tag.tagType == tagTypeVariable {
			seen[tag.varPath] = struct{}{}
		} else if tag.tagType == tagTypeHelper {
			for _, arg := range tag.posArgs {
				if arg.isVar && templatePlaceholderPattern.MatchString("{{"+arg.varPath+"}}") && arg.varPath != "this" {
					seen[arg.varPath] = struct{}{}
				}
			}
			for _, arg := range tag.options {
				if arg.isVar && templatePlaceholderPattern.MatchString("{{"+arg.varPath+"}}") && arg.varPath != "this" {
					seen[arg.varPath] = struct{}{}
				}
			}
		}
	}
	paths := make([]string, 0, len(seen))
	for path := range seen {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}
