package main

import (
	"encoding/json"
	"errors"
	"fmt"
	stdhtml "html"
	"io"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

func isDocumentRenderRequest(request events.APIGatewayProxyRequest) bool {
	return request.Resource == dashboardDocumentRenderResource || request.Path == dashboardDocumentRenderResource
}

// resolveDocumentRenderHTML is the narrow seam between request validation and
// the shared PDF pipeline. It returns only safe, fully resolved document HTML
// along with optional notification settings handled by the existing pipeline.
func resolveDocumentRenderHTML(body string) (string, documentRenderRequest, error) {
	request, err := parseDocumentRenderRequest(body)
	if err != nil {
		return "", documentRenderRequest{}, err
	}
	if request.Source != nil {
		resolvedMarkdown, err := resolveDocumentMarkdown(request.Source.Content, request.Data)
		if err != nil {
			return "", documentRenderRequest{}, err
		}
		fragment, err := renderMarkdownToHTML(resolvedMarkdown)
		if err != nil {
			return "", documentRenderRequest{}, documentRequestError(422, "document_markdown_invalid", "Markdown could not be converted")
		}
		if err := validateDocumentSafety(fragment, request.CSS); err != nil {
			return "", documentRenderRequest{}, err
		}
		documentHTML, err := buildDocumentHTMLFromResolvedHTML(fragment, markdownDocumentDefaultCSS+request.CSS, request.Options)
		if err != nil {
			return "", documentRenderRequest{}, err
		}
		return documentHTML, request, nil
	}
	documentHTML, err := buildDocumentHTML(request)
	if err != nil {
		return "", documentRenderRequest{}, err
	}
	return documentHTML, request, nil
}

// parseDocumentRenderRequest accepts exactly one JSON object and rejects
// unknown fields. This prevents silent typos from becoming part of a public
// API contract. Data may be an empty object for documents without bindings,
// but it must be supplied so callers explicitly choose the document mode.
func parseDocumentRenderRequest(body string) (documentRenderRequest, error) {
	if len(body) > maxDocumentRequestBytes {
		return documentRenderRequest{}, documentRequestError(413, "document_request_too_large", fmt.Sprintf("Document request must not exceed %d bytes", maxDocumentRequestBytes))
	}
	var request documentRenderRequest
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return documentRenderRequest{}, &renderError{Code: "document_request_invalid", Message: "Invalid document render request", Status: 400}
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return documentRenderRequest{}, &renderError{Code: "document_request_invalid", Message: "Invalid document render request", Status: 400}
	}
	if request.Version != documentRequestVersion {
		return documentRenderRequest{}, &renderError{Code: "document_version_unsupported", Message: "version must be \"1\"", Status: 422}
	}
	if err := validateDocumentMarkdownSource(request.Source, request.HTML); err != nil {
		return documentRenderRequest{}, err
	}
	if request.Source == nil && strings.TrimSpace(request.HTML) == "" {
		return documentRenderRequest{}, &renderError{Code: "document_html_required", Message: "html is required", Status: 422}
	}
	if request.Data == nil {
		return documentRenderRequest{}, &renderError{Code: "document_data_required", Message: "data is required", Status: 422}
	}
	if request.Source == nil && len(request.HTML) > maxDocumentHTMLBytes {
		return documentRenderRequest{}, documentRequestError(413, "document_html_too_large", fmt.Sprintf("html must not exceed %d bytes", maxDocumentHTMLBytes))
	}
	if len(request.CSS) > maxDocumentCSSBytes {
		return documentRenderRequest{}, documentRequestError(413, "document_css_too_large", fmt.Sprintf("css must not exceed %d bytes", maxDocumentCSSBytes))
	}
	dataBytes, err := json.Marshal(request.Data)
	if err != nil || len(dataBytes) > maxDocumentDataBytes {
		return documentRenderRequest{}, documentRequestError(413, "document_data_too_large", fmt.Sprintf("data must not exceed %d bytes", maxDocumentDataBytes))
	}
	if err := validateDocumentDataDepth(request.Data, 1); err != nil {
		return documentRenderRequest{}, err
	}
	content := request.HTML
	if request.Source != nil {
		content = request.Source.Content
	}
	if err := validateDocumentRenderInputSize(content, request.CSS); err != nil {
		return documentRenderRequest{}, err
	}
	if err := validateDocumentOptions(&request.Options); err != nil {
		return documentRenderRequest{}, err
	}
	if request.Options.getWaitForFunction() != "" {
		return documentRenderRequest{}, documentRequestError(422, "document_wait_function_disallowed", "options.waitFor.function is not supported when JavaScript is disabled")
	}
	if err := validateDocumentPageSettings(content, request.CSS); err != nil {
		return documentRenderRequest{}, err
	}
	if request.Source == nil {
		if err := validateDocumentSafety(request.HTML, request.CSS); err != nil {
			return documentRenderRequest{}, err
		}
		if _, err := buildDocumentHTML(request); err != nil {
			return documentRenderRequest{}, err
		}
	} else {
		if err := validateDocumentCSS(request.CSS); err != nil {
			return documentRenderRequest{}, err
		}
		if _, err := resolveDocumentMarkdown(request.Source.Content, request.Data); err != nil {
			return documentRenderRequest{}, err
		}
	}
	return request, nil
}

// resolveDocumentMarkdown applies the established strict binding contract
// before conversion. Values are treated as Markdown plain text: HTML escaping
// prevents tag injection and Markdown escaping prevents values from creating
// formatting, links, tables, or other document structure.
func resolveDocumentMarkdown(markdown string, data map[string]any) (string, error) {
	if _, err := resolveDocumentHTML(markdown, data); err != nil {
		return "", err
	}
	values, err := flattenTemplateVariables(data, "")
	if err != nil {
		return "", documentRequestError(422, "document_binding_invalid", "Document bindings are invalid")
	}
	matches := templateTagPattern.FindAllStringSubmatchIndex(markdown, -1)
	var result strings.Builder
	lastIndex := 0
	for _, match := range matches {
		result.WriteString(markdown[lastIndex:match[0]])
		rawInner := markdown[match[2]:match[3]]
		tag, err := parseTemplateTag(rawInner)
		if err == nil {
			if tag.tagType == tagTypeVariable {
				result.WriteString(escapeMarkdownBindingValue(values[tag.varPath]))
			} else if tag.tagType == tagTypeHelper {
				svg, err := executeTemplateHelper(tag, values)
				if err == nil {
					result.WriteString(svg)
				}
			}
		}
		lastIndex = match[1]
	}
	result.WriteString(markdown[lastIndex:])
	return result.String(), nil
}

func escapeMarkdownBindingValue(value any) string {
	return markdownBindingEscaper.Replace(stdhtml.EscapeString(fmt.Sprint(value)))
}

// resolveDocumentHTML shares the established template binding engine with
// stored templates. It resolves every {{path.to.value}} placeholder and
// HTML-escapes values before they become document markup. Every placeholder
// needs a data value, and every supplied data leaf must be consumed.
func resolveDocumentHTML(html string, data map[string]any) (string, error) {
	resolvedHTML, err := renderTemplateHTML(html, data)
	if err == nil {
		return resolvedHTML, nil
	}
	var templateErr *renderError
	if !errors.As(err, &templateErr) {
		return "", documentRequestError(422, "document_binding_invalid", "Document bindings are invalid")
	}
	switch templateErr.Code {
	case missingTemplateVariableCode:
		return "", documentRequestError(422, "document_binding_missing", templateErr.Message)
	case unknownTemplateVariableCode:
		return "", documentRequestError(422, "document_binding_unknown", templateErr.Message)
	default:
		return "", documentRequestError(422, "document_binding_invalid", templateErr.Message)
	}
}

// buildDocumentHTML produces the only document shell passed to Chromium. Page
// dimensions are generated from the already-validated options, not supplied by
// document authors as raw HTML. User-provided @page rules are rejected during
// request validation so they cannot override this controlled page layout.
func buildDocumentHTML(request documentRenderRequest) (string, error) {
	resolvedHTML, err := resolveDocumentHTML(request.HTML, request.Data)
	if err != nil {
		return "", err
	}
	return buildDocumentHTMLFromResolvedHTML(resolvedHTML, request.CSS, request.Options)
}

func buildDocumentHTMLFromResolvedHTML(resolvedHTML, css string, options documentRenderOptions) (string, error) {
	pageSize := options.Format
	if options.isLandscape() {
		pageSize += " landscape"
	}
	pageCSS := fmt.Sprintf("@page { size: %s; margin: %s; }", pageSize, options.Margin)
	documentHTML := "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<style>\n" + css + "\n" + pageCSS + "\n</style>\n</head>\n<body>\n" + resolvedHTML + "\n</body>\n</html>"
	documentHTML = transformRedaction(documentHTML, options.Redaction)
	documentHTML = transformBarcodes(documentHTML)
	documentHTML = injectPrintCSS(documentHTML)
	if err := validateDocumentRenderInputSize(documentHTML, ""); err != nil {
		return "", err
	}
	return documentHTML, nil
}
