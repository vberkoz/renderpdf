package main

import (
	"encoding/json"
	"regexp"
	"strings"
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
	maxDocumentTemplateBytes        = 64 * 1024
	maxDocumentDataDepth            = 10
	defaultDocumentFormat           = "A4"
	defaultDocumentMargin           = "18mm"
	maxDocumentMarginMillimeters    = 50
	maxDocumentMarginInches         = 2
	markdownDocumentDefaultCSS      = `
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #24292e; max-width: 800px; margin: 0 auto; padding: 2rem; background-color: #ffffff; }
h1, h2, h3, h4, h5, h6 { margin-top: 1.5rem; margin-bottom: 1rem; font-weight: 600; line-height: 1.25; break-after: avoid; page-break-after: avoid; }
h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
h3 { font-size: 1.25em; }
a { color: #0366d6; text-decoration: none; }
a:hover { text-decoration: underline; }
p, blockquote, ul, ol, dl, table, pre { margin-top: 0; margin-bottom: 16px; }
p, li { orphans: 3; widows: 3; }
ul, ol { padding-left: 2em; }
li + li { margin-top: 0.25em; }
blockquote { padding: 0 1em; color: #6a737d; border-left: 0.25em solid #dfe2e5; margin-left: 0; break-inside: avoid; page-break-inside: avoid; }
code { padding: 0.2em 0.4em; margin: 0; font-size: 85%; background-color: rgba(27, 31, 35, 0.05); border-radius: 3px; font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace; }
pre { max-width: 100%; padding: 16px; overflow: visible; font-size: 85%; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; background-color: #f6f8fa; border-radius: 3px; break-inside: avoid; page-break-inside: avoid; }
pre code { background-color: transparent; padding: 0; font-size: 100%; white-space: inherit; overflow-wrap: inherit; word-break: inherit; }
table { border-spacing: 0; border-collapse: collapse; width: 100%; }
table thead { display: table-header-group; }
table tfoot { display: table-row-group; }
table th, table td { padding: 6px 13px; border: 1px solid #dfe2e5; }
table tr { background-color: #fff; border-top: 1px solid #c6cbd1; break-inside: avoid; page-break-inside: avoid; }
table tr:nth-child(2n) { background-color: #f6f8fa; }
img { max-width: 100%; box-sizing: content-box; background-color: #fff; break-inside: avoid; page-break-inside: avoid; }
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
	encoded, err := normalizedDocumentDefinitionJSON(request)
	if err != nil {
		return 0
	}
	return int64(len(encoded))
}

// waitForOptions defines readiness conditions evaluated before printing.
type waitForOptions struct {
	Selector    string `json:"selector,omitempty"`
	Function    string `json:"function,omitempty"`
	TimeoutMs   int    `json:"timeoutMs,omitempty"`
	NetworkIdle string `json:"networkIdle,omitempty"`
	Fonts       *bool  `json:"fonts,omitempty"`
}

// pageNumberOptions defines vector watermark page numbering stamped via pdfcpu.
type pageNumberOptions struct {
	Format       string `json:"format,omitempty"`
	Position     string `json:"position,omitempty"`
	StartPage    int    `json:"startPage,omitempty"`
	StartNumber  int    `json:"startNumber,omitempty"`
	ExcludeCover bool   `json:"excludeCover,omitempty"`
	FontSize     int    `json:"fontSize,omitempty"`
	Color        string `json:"color,omitempty"`
}

// documentRenderOptions describes the bounded layout intent accepted by the
// contract. Conversion into Chromium print options is added with the document
// compiler, but all accepted values are validated here.
type documentRenderOptions struct {
	Format              string             `json:"format,omitempty"`
	Margin              string             `json:"margin,omitempty"`
	Landscape           *bool              `json:"landscape,omitempty"`
	HeaderTemplate      string             `json:"headerTemplate,omitempty"`
	FooterTemplate      string             `json:"footerTemplate,omitempty"`
	DisplayHeaderFooter *bool              `json:"displayHeaderFooter,omitempty"`
	Password            string             `json:"password,omitempty"`
	OwnerPassword       string             `json:"ownerPassword,omitempty"`
	Permissions         string             `json:"permissions,omitempty"`
	WaitFor             *waitForOptions    `json:"waitFor,omitempty"`
	WaitForSelector     string             `json:"waitForSelector,omitempty"`
	WaitForFunction     string             `json:"waitForFunction,omitempty"`
	WaitForFonts        *bool              `json:"waitForFonts,omitempty"`
	NetworkIdle         string             `json:"networkIdle,omitempty"`
	TimeoutMs           int                `json:"timeoutMs,omitempty"`
	PageNumbers         *pageNumberOptions `json:"pageNumbers,omitempty"`
	Watermark           *watermarkOptions  `json:"watermark,omitempty"`
	Compliance          *complianceOptions `json:"compliance,omitempty"`
	ZeroRetention       *bool              `json:"zeroRetention,omitempty"`
	ResponseFormat      string             `json:"responseFormat,omitempty"`
	StrictVariables     *bool              `json:"strictVariables,omitempty"`
	AllowExtraVariables *bool              `json:"allowExtraVariables,omitempty"`
	CustomHeaders       map[string]string  `json:"-"`
	CustomCookies       []urlCookie        `json:"-"`
}

func (o documentRenderOptions) isLandscape() bool {
	return o.Landscape != nil && *o.Landscape
}

func (o documentRenderOptions) isZeroRetention() bool {
	return o.ZeroRetention != nil && *o.ZeroRetention
}

func (o documentRenderOptions) isBinaryResponse() bool {
	switch strings.ToLower(strings.TrimSpace(o.ResponseFormat)) {
	case "binary", "pdf":
		return true
	default:
		return false
	}
}

func (o documentRenderOptions) allowExtraVariables() bool {
	if o.AllowExtraVariables != nil {
		return *o.AllowExtraVariables
	}
	if o.StrictVariables != nil {
		return !*o.StrictVariables
	}
	return false
}

func (o documentRenderOptions) getWaitForSelector() string {
	if o.WaitFor != nil && o.WaitFor.Selector != "" {
		return o.WaitFor.Selector
	}
	return o.WaitForSelector
}

func (o documentRenderOptions) getWaitForFunction() string {
	if o.WaitFor != nil && o.WaitFor.Function != "" {
		return o.WaitFor.Function
	}
	return o.WaitForFunction
}

func (o documentRenderOptions) getWaitForFonts() bool {
	if o.WaitFor != nil && o.WaitFor.Fonts != nil {
		return *o.WaitFor.Fonts
	}
	if o.WaitForFonts != nil {
		return *o.WaitForFonts
	}
	return true
}

func (o documentRenderOptions) getNetworkIdle() string {
	if o.WaitFor != nil && o.WaitFor.NetworkIdle != "" {
		return o.WaitFor.NetworkIdle
	}
	return o.NetworkIdle
}

func (o documentRenderOptions) getTimeoutMs() int {
	if o.WaitFor != nil && o.WaitFor.TimeoutMs != 0 {
		return o.WaitFor.TimeoutMs
	}
	return o.TimeoutMs
}

func (o documentRenderOptions) hasExplicitWaitForTrigger() bool {
	if o.getWaitForSelector() != "" || o.getWaitForFunction() != "" {
		return true
	}
	idleMode := strings.ToLower(strings.TrimSpace(o.getNetworkIdle()))
	return idleMode == "networkidle0" || idleMode == "networkidle2"
}

func (o documentRenderOptions) isZero() bool {
	return o.Format == "" &&
		o.Margin == "" &&
		o.Landscape == nil &&
		o.HeaderTemplate == "" &&
		o.FooterTemplate == "" &&
		o.DisplayHeaderFooter == nil &&
		o.Password == "" &&
		o.OwnerPassword == "" &&
		o.Permissions == "" &&
		o.WaitFor == nil &&
		o.WaitForSelector == "" &&
		o.WaitForFunction == "" &&
		o.WaitForFonts == nil &&
		o.NetworkIdle == "" &&
		o.TimeoutMs == 0 &&
		o.PageNumbers == nil &&
		o.Watermark == nil &&
		o.Compliance == nil &&
		o.ZeroRetention == nil &&
		o.ResponseFormat == "" &&
		o.StrictVariables == nil &&
		o.AllowExtraVariables == nil
}

func mergeDocumentRenderOptions(base, override documentRenderOptions) documentRenderOptions {
	merged := base
	if override.Format != "" {
		merged.Format = override.Format
	}
	if override.Margin != "" {
		merged.Margin = override.Margin
	}
	if override.Landscape != nil {
		v := *override.Landscape
		merged.Landscape = &v
	}
	if override.HeaderTemplate != "" {
		merged.HeaderTemplate = override.HeaderTemplate
	}
	if override.FooterTemplate != "" {
		merged.FooterTemplate = override.FooterTemplate
	}
	if override.DisplayHeaderFooter != nil {
		v := *override.DisplayHeaderFooter
		merged.DisplayHeaderFooter = &v
	}
	if override.Password != "" {
		merged.Password = override.Password
	}
	if override.OwnerPassword != "" {
		merged.OwnerPassword = override.OwnerPassword
	}
	if override.Permissions != "" {
		merged.Permissions = override.Permissions
	}
	if override.WaitFor != nil {
		wf := *override.WaitFor
		if override.WaitFor.Fonts != nil {
			v := *override.WaitFor.Fonts
			wf.Fonts = &v
		}
		merged.WaitFor = &wf
	}
	if override.WaitForSelector != "" {
		merged.WaitForSelector = override.WaitForSelector
	}
	if override.WaitForFunction != "" {
		merged.WaitForFunction = override.WaitForFunction
	}
	if override.WaitForFonts != nil {
		v := *override.WaitForFonts
		merged.WaitForFonts = &v
	}
	if override.NetworkIdle != "" {
		merged.NetworkIdle = override.NetworkIdle
	}
	if override.TimeoutMs != 0 {
		merged.TimeoutMs = override.TimeoutMs
	}
	if override.PageNumbers != nil {
		pn := *override.PageNumbers
		merged.PageNumbers = &pn
	}
	if override.Watermark != nil {
		wm := *override.Watermark
		merged.Watermark = &wm
	}
	if override.Compliance != nil {
		c := *override.Compliance
		merged.Compliance = &c
	}
	if override.ZeroRetention != nil {
		v := *override.ZeroRetention
		merged.ZeroRetention = &v
	}
	if override.ResponseFormat != "" {
		merged.ResponseFormat = override.ResponseFormat
	}
	if override.StrictVariables != nil {
		v := *override.StrictVariables
		merged.StrictVariables = &v
	}
	if override.AllowExtraVariables != nil {
		v := *override.AllowExtraVariables
		merged.AllowExtraVariables = &v
	}
	return merged
}

func documentRequestError(status int, code, message string) *renderError {
	return &renderError{Code: code, Message: message, Status: status}
}
