package main

import (
	"encoding/json"
	"errors"
	"fmt"
	stdhtml "html"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	nethtml "golang.org/x/net/html"
)

const (
	documentRequestVersion          = "1"
	dashboardDocumentRenderResource = "/api/v1/dashboard/render-document"
	maxDocumentRequestBytes         = 1024 * 1024
	maxDocumentHTMLBytes            = 768 * 1024
	maxDocumentMarkdownBytes        = 768 * 1024
	maxDocumentCSSBytes             = 128 * 1024
	maxDocumentDataBytes            = 256 * 1024
	maxDocumentRenderInputBytes     = 1024 * 1024
	maxDocumentDataDepth            = 10
	defaultDocumentFormat           = "A4"
	defaultDocumentMargin           = "18mm"
	maxDocumentMarginMillimeters    = 50
	maxDocumentMarginInches         = 2
	markdownDocumentDefaultCSS      = `
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #24292e; max-width: 800px; margin: 0 auto; padding: 2rem; background-color: #ffffff; }
h1, h2, h3, h4, h5, h6 { margin-top: 1.5rem; margin-bottom: 1rem; font-weight: 600; line-height: 1.25; }
h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
h3 { font-size: 1.25em; }
a { color: #0366d6; text-decoration: none; }
a:hover { text-decoration: underline; }
p, blockquote, ul, ol, dl, table, pre { margin-top: 0; margin-bottom: 16px; }
ul, ol { padding-left: 2em; }
li + li { margin-top: 0.25em; }
blockquote { padding: 0 1em; color: #6a737d; border-left: 0.25em solid #dfe2e5; margin-left: 0; }
code { padding: 0.2em 0.4em; margin: 0; font-size: 85%; background-color: rgba(27, 31, 35, 0.05); border-radius: 3px; font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace; }
pre { max-width: 100%; padding: 16px; overflow: visible; font-size: 85%; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; background-color: #f6f8fa; border-radius: 3px; }
pre code { background-color: transparent; padding: 0; font-size: 100%; white-space: inherit; overflow-wrap: inherit; word-break: inherit; }
table { border-spacing: 0; border-collapse: collapse; width: 100%; }
table th, table td { padding: 6px 13px; border: 1px solid #dfe2e5; }
table tr { background-color: #fff; border-top: 1px solid #c6cbd1; }
table tr:nth-child(2n) { background-color: #f6f8fa; }
img { max-width: 100%; box-sizing: content-box; background-color: #fff; }
`
)

var (
	documentMarginPattern    = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?)(mm|in)$`)
	documentPageRulePattern  = regexp.MustCompile(`(?i)@page\b`)
	documentCSSURLPattern    = regexp.MustCompile(`(?i)url\s*\(`)
	documentCSSImportPattern = regexp.MustCompile(`(?i)@import\b`)
	documentCSSUnsafePattern = regexp.MustCompile(`(?i)(expression\s*\(|-moz-binding\b|behavior\s*:)`)
)

var markdownBindingEscaper = strings.NewReplacer(
	"\\", "\\\\",
	"`", "\\`",
	"*", "\\*",
	"_", "\\_",
	"{", "\\{",
	"}", "\\}",
	"[", "\\[",
	"]", "\\]",
	"(", "\\(",
	")", "\\)",
	"<", "\\<",
	">", "\\>",
	"#", "\\#",
	"+", "\\+",
	"-", "\\-",
	".", "\\.",
	"!", "\\!",
	"|", "\\|",
	"~", "\\~",
)

func isDocumentRenderRequest(request events.APIGatewayProxyRequest) bool {
	return request.Resource == dashboardDocumentRenderResource || request.Path == dashboardDocumentRenderResource
}

// documentRenderRequest is the versioned, inline source-document contract.
// The document compiler resolves data bindings, builds the full HTML document,
// and sends it to the existing PDF pipeline. Keeping that work out of this
// parser keeps the public request shape independently testable.
type documentRenderRequest struct {
	Version       string                `json:"version"`
	HTML          string                `json:"html"`
	Source        *documentRenderSource `json:"source,omitempty"`
	CSS           string                `json:"css"`
	Data          map[string]any        `json:"data"`
	Options       documentRenderOptions `json:"options"`
	Label         string                `json:"label,omitempty"`
	WebhookURL    string                `json:"webhookUrl,omitempty"`
	WebhookSecret string                `json:"webhookSecret,omitempty"`
}

// documentRenderSource is the forward-compatible content carrier for source
// formats such as Markdown. Existing callers continue to use top-level html.
type documentRenderSource struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

// normalizedDocumentDefinition is the persistence-ready representation of a
// document render. It deliberately excludes delivery configuration, so a
// future source file or batch item can reference the same document regardless
// of whether a particular render sends a webhook.
type normalizedDocumentDefinition struct {
	Version string                `json:"version"`
	HTML    string                `json:"html"`
	Source  *documentRenderSource `json:"source,omitempty"`
	CSS     string                `json:"css"`
	Data    map[string]any        `json:"data"`
	Options documentRenderOptions `json:"options"`
}

func normalizedDocumentDefinitionFor(request documentRenderRequest) normalizedDocumentDefinition {
	return normalizedDocumentDefinition{
		Version: request.Version,
		HTML:    request.HTML,
		Source:  request.Source,
		CSS:     request.CSS,
		Data:    request.Data,
		Options: request.Options,
	}
}

// normalizedDocumentDefinitionJSON is the byte representation a future source
// file or batch item can store and submit back to the same document compiler.
func normalizedDocumentDefinitionJSON(request documentRenderRequest) ([]byte, error) {
	return json.Marshal(normalizedDocumentDefinitionFor(request))
}

func normalizedDocumentDefinitionBytes(request documentRenderRequest) int64 {
	// Requests are decoded from JSON and fully validated before this point, so
	// marshaling the normalized source cannot fail in normal operation.
	encoded, err := normalizedDocumentDefinitionJSON(request)
	if err != nil {
		return 0
	}
	return int64(len(encoded))
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

// documentRenderOptions describes the bounded layout intent accepted by the
// contract. Conversion into Chromium print options is added with the document
// compiler, but all accepted values are validated here.
type documentRenderOptions struct {
	Format string `json:"format,omitempty"`
	Margin string `json:"margin,omitempty"`
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

// validateDocumentMarkdownSource keeps the source branch strict before it
// reaches the CommonMark compiler. Unknown source fields are rejected by the
// JSON decoder's DisallowUnknownFields setting in parseDocumentRenderRequest.
func validateDocumentMarkdownSource(source *documentRenderSource, legacyHTML string) error {
	if source == nil {
		return nil
	}
	if strings.TrimSpace(legacyHTML) != "" {
		return &renderError{Code: "document_source_conflict", Message: "source and html cannot be used together", Status: 422}
	}
	if source.Type != "markdown" {
		return &renderError{Code: "document_source_type_invalid", Message: "source.type must be \"markdown\"", Status: 422}
	}
	if strings.TrimSpace(source.Content) == "" {
		return &renderError{Code: "document_source_content_required", Message: "source.content is required", Status: 422}
	}
	if len(source.Content) > maxDocumentMarkdownBytes {
		return documentRequestError(413, "document_source_too_large", fmt.Sprintf("source.content must not exceed %d bytes", maxDocumentMarkdownBytes))
	}
	return nil
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
	return templatePlaceholderPattern.ReplaceAllStringFunc(markdown, func(placeholder string) string {
		path := templatePlaceholderPattern.FindStringSubmatch(placeholder)[1]
		return escapeMarkdownBindingValue(values[path])
	}), nil
}

func escapeMarkdownBindingValue(value any) string {
	return markdownBindingEscaper.Replace(stdhtml.EscapeString(fmt.Sprint(value)))
}

// validateDocumentSafety rejects active markup and external/local assets. The
// document endpoint deliberately has no asset allowlist yet, so all asset URLs
// are denied rather than fetched by Chrome during a render.
func validateDocumentSafety(htmlSource, css string) error {
	if err := validateDocumentCSS(css); err != nil {
		return err
	}
	document, err := nethtml.Parse(strings.NewReader(htmlSource))
	if err != nil {
		return documentRequestError(422, "document_html_invalid", "HTML could not be parsed")
	}
	return walkDocumentNodes(document)
}

func walkDocumentNodes(node *nethtml.Node) error {
	tag := strings.ToLower(node.Data)
	switch tag {
	case "script", "iframe", "embed", "object", "applet", "base", "link":
		return documentRequestError(422, "document_html_unsafe", fmt.Sprintf("HTML <%s> elements are not allowed", tag))
	case "meta":
		for _, attribute := range node.Attr {
			if strings.EqualFold(attribute.Key, "http-equiv") && strings.EqualFold(strings.TrimSpace(attribute.Val), "refresh") {
				return documentRequestError(422, "document_html_unsafe", "HTML meta refresh is not allowed")
			}
		}
	}
	for _, attribute := range node.Attr {
		name := strings.ToLower(attribute.Key)
		if strings.HasPrefix(name, "on") {
			return documentRequestError(422, "document_html_unsafe", "HTML event-handler attributes are not allowed")
		}
		switch name {
		case "style":
			if err := validateDocumentCSS(attribute.Val); err != nil {
				return err
			}
		case "src", "srcset", "poster", "data", "background":
			if strings.TrimSpace(attribute.Val) != "" {
				return documentRequestError(422, "document_asset_disallowed", "Document assets are not allowed")
			}
		case "href":
			if tag == "link" {
				return documentRequestError(422, "document_asset_disallowed", "Document assets are not allowed")
			}
			if err := validateDocumentLinkURL(attribute.Val); err != nil {
				return err
			}
		case "action", "formaction":
			if err := validateDocumentLinkURL(attribute.Val); err != nil {
				return err
			}
		}
		if strings.EqualFold(attribute.Namespace, "xlink") && name == "href" {
			if err := validateDocumentLinkURL(attribute.Val); err != nil {
				return err
			}
		}
	}
	if tag == "style" {
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			if child.Type == nethtml.TextNode {
				if err := validateDocumentCSS(child.Data); err != nil {
					return err
				}
			}
		}
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if err := walkDocumentNodes(child); err != nil {
			return err
		}
	}
	return nil
}

func validateDocumentCSS(css string) error {
	switch {
	case documentCSSImportPattern.MatchString(css):
		return documentRequestError(422, "document_css_unsafe", "CSS @import rules are not allowed")
	case documentCSSURLPattern.MatchString(css):
		return documentRequestError(422, "document_asset_disallowed", "CSS url() assets are not allowed")
	case documentCSSUnsafePattern.MatchString(css):
		return documentRequestError(422, "document_css_unsafe", "Unsafe CSS is not allowed")
	}
	return nil
}

func validateDocumentLinkURL(raw string) error {
	value := strings.TrimSpace(raw)
	if value == "" || strings.HasPrefix(value, "#") {
		return nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" {
		return documentRequestError(422, "document_url_unsafe", "Document URLs must use http, https, or mailto")
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "mailto":
		return nil
	default:
		return documentRequestError(422, "document_url_unsafe", "Document URLs must use http, https, or mailto")
	}
}

func validateDocumentPageSettings(html, css string) error {
	if documentPageRulePattern.MatchString(html) || documentPageRulePattern.MatchString(css) {
		return documentRequestError(422, "document_page_settings_disallowed", "@page settings must be supplied through options")
	}
	return nil
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
	pageCSS := fmt.Sprintf("@page { size: %s; margin: %s; }", options.Format, options.Margin)
	documentHTML := "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<style>\n" + css + "\n" + pageCSS + "\n</style>\n</head>\n<body>\n" + resolvedHTML + "\n</body>\n</html>"
	if err := validateDocumentRenderInputSize(documentHTML, ""); err != nil {
		return "", err
	}
	return documentHTML, nil
}

func validateDocumentDataDepth(value any, depth int) error {
	if depth > maxDocumentDataDepth {
		return documentRequestError(422, "document_data_too_deep", fmt.Sprintf("data must not exceed %d nested levels", maxDocumentDataDepth))
	}
	switch typed := value.(type) {
	case map[string]any:
		for _, child := range typed {
			if err := validateDocumentDataDepth(child, depth+1); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range typed {
			if err := validateDocumentDataDepth(child, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

// validateDocumentRenderInputSize is also called after binding resolution by
// the future document compiler, where it guards against repeated data values
// making the final HTML larger than the submitted source document.
func validateDocumentRenderInputSize(html, css string) error {
	if len(html)+len(css) > maxDocumentRenderInputBytes {
		return documentRequestError(413, "document_render_input_too_large", fmt.Sprintf("Rendered document input must not exceed %d bytes", maxDocumentRenderInputBytes))
	}
	return nil
}

func validateDocumentOptions(options *documentRenderOptions) error {
	if options.Format == "" {
		options.Format = defaultDocumentFormat
	}
	if options.Margin == "" {
		options.Margin = defaultDocumentMargin
	}
	switch options.Format {
	case "A4", "Letter", "Legal":
	default:
		return documentRequestError(422, "document_format_invalid", "options.format must be one of A4, Letter, or Legal")
	}
	match := documentMarginPattern.FindStringSubmatch(options.Margin)
	if match == nil {
		return documentRequestError(422, "document_margin_invalid", "options.margin must be a value from 0mm to 50mm or 0in to 2in")
	}
	value, _ := strconv.ParseFloat(match[1], 64)
	maximum := float64(maxDocumentMarginMillimeters)
	if match[2] == "in" {
		maximum = maxDocumentMarginInches
	}
	if value < 0 || value > maximum {
		return documentRequestError(422, "document_margin_invalid", "options.margin must be a value from 0mm to 50mm or 0in to 2in")
	}
	return nil
}

func documentRequestError(status int, code, message string) *renderError {
	return &renderError{Code: code, Message: message, Status: status}
}
