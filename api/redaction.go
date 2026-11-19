package main

import (
	"bytes"
	"fmt"
	stdhtml "html"
	"regexp"
	"strings"

	nethtml "golang.org/x/net/html"
)

var (
	ssnRegex        = regexp.MustCompile(`\b\d{3}[- ]?\d{2}[- ]?\d{4}\b|\b\d{9}\b`)
	creditCardRegex = regexp.MustCompile(`\b(?:\d{4}[ -]?){3}\d{4}\b|\b\d{15,16}\b`)
	emailRegex      = regexp.MustCompile(`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`)
	phoneRegex      = regexp.MustCompile(`\b(?:\+?1[-. ]?)?\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})\b`)
)

type redactionOptions struct {
	Enabled         bool     `json:"enabled,omitempty"`
	Types           []string `json:"types,omitempty"`           // "ssn", "creditCard", "email", "phone"
	Patterns        []string `json:"patterns,omitempty"`        // custom regex strings
	Replacement     string   `json:"replacement,omitempty"`     // "bar" (default), "mask", "text"
	ReplacementText string   `json:"replacementText,omitempty"` // custom replacement e.g. "[REDACTED]"
}

type signingOptions struct {
	Certificate string `json:"certificate,omitempty"` // base64 PEM or PKCS#12 (.p12/.pfx)
	PrivateKey  string `json:"privateKey,omitempty"`  // base64 PEM private key
	Password    string `json:"password,omitempty"`    // PKCS#12 or private key password
	KmsKeyID    string `json:"kmsKeyId,omitempty"`    // AWS KMS Key ID or ARN
	Name        string `json:"name,omitempty"`        // Signer name
	Reason      string `json:"reason,omitempty"`      // Signing reason
	Location    string `json:"location,omitempty"`    // Signing location
	ContactInfo string `json:"contactInfo,omitempty"` // Contact email or phone
}

func maskSSN(s string) string {
	digits := extractDigits(s)
	if len(digits) >= 4 {
		return "***-**-" + digits[len(digits)-4:]
	}
	return "***-**-****"
}

func maskCreditCard(s string) string {
	digits := extractDigits(s)
	if len(digits) >= 4 {
		return "****-****-****-" + digits[len(digits)-4:]
	}
	return "****-****-****-****"
}

func maskEmail(s string) string {
	parts := strings.Split(s, "@")
	if len(parts) != 2 || len(parts[0]) == 0 {
		return "***@***.***"
	}
	name := parts[0]
	domain := parts[1]
	maskedName := string(name[0]) + "***"
	return maskedName + "@" + domain
}

func maskPhone(s string) string {
	digits := extractDigits(s)
	if len(digits) >= 4 {
		return "(***) ***-" + digits[len(digits)-4:]
	}
	return "(***) ***-****"
}

func maskGeneric(s string) string {
	runes := []rune(s)
	if len(runes) <= 4 {
		return strings.Repeat("*", len(runes))
	}
	return strings.Repeat("*", len(runes)-4) + string(runes[len(runes)-4:])
}

func extractDigits(s string) string {
	var sb strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

// renderRedactionSpan formats the replacement output.
// "bar" replaces the text with an opaque solid black block that contains no underlying glyphs.
func renderRedactionSpan(original string, piiType string, replacement string, customText string) string {
	mode := strings.ToLower(strings.TrimSpace(replacement))
	if mode == "" {
		mode = "bar"
	}

	switch mode {
	case "mask":
		masked := original
		switch strings.ToLower(piiType) {
		case "ssn":
			masked = maskSSN(original)
		case "creditcard", "card":
			masked = maskCreditCard(original)
		case "email":
			masked = maskEmail(original)
		case "phone":
			masked = maskPhone(original)
		default:
			masked = maskGeneric(original)
		}
		return stdhtml.EscapeString(masked)

	case "text":
		txt := customText
		if txt == "" {
			txt = "[REDACTED]"
		}
		return fmt.Sprintf(`<span class="pdf-redaction-text" style="color:#374151;font-weight:600;font-family:monospace;">%s</span>`, stdhtml.EscapeString(txt))

	case "bar":
		fallthrough
	default:
		// Solid black bar with transparent placeholder so character shapes are not in the PDF stream
		return `<span class="pdf-redaction-bar" style="display:inline-block;background-color:#000000;color:transparent;user-select:none;-webkit-user-select:none;border-radius:2px;padding:0 4px;font-family:monospace;letter-spacing:-1px;">████████</span>`
	}
}

// transformRedaction parses HTML, excises PII, and replaces sensitive data
// with secure visual black bars or masked text.
func transformRedaction(htmlStr string, options *redactionOptions) string {
	hasRedactTag := strings.Contains(htmlStr, "<redact") || strings.Contains(htmlStr, "data-redact")
	optionsActive := options != nil && options.Enabled

	if !hasRedactTag && !optionsActive {
		return htmlStr
	}

	doc, err := nethtml.Parse(strings.NewReader(htmlStr))
	if err != nil {
		return htmlStr
	}

	defaultReplacement := "bar"
	customText := ""
	var compiledPatterns []*regexp.Regexp
	var patternTypes []string

	if optionsActive {
		if options.Replacement != "" {
			defaultReplacement = options.Replacement
		}
		if options.ReplacementText != "" {
			customText = options.ReplacementText
		}

		for _, t := range options.Types {
			switch strings.ToLower(strings.TrimSpace(t)) {
			case "ssn":
				compiledPatterns = append(compiledPatterns, ssnRegex)
				patternTypes = append(patternTypes, "ssn")
			case "creditcard", "card":
				compiledPatterns = append(compiledPatterns, creditCardRegex)
				patternTypes = append(patternTypes, "creditCard")
			case "email":
				compiledPatterns = append(compiledPatterns, emailRegex)
				patternTypes = append(patternTypes, "email")
			case "phone":
				compiledPatterns = append(compiledPatterns, phoneRegex)
				patternTypes = append(patternTypes, "phone")
			}
		}

		for _, pat := range options.Patterns {
			if r, err := regexp.Compile(pat); err == nil {
				compiledPatterns = append(compiledPatterns, r)
				patternTypes = append(patternTypes, "custom")
			}
		}
	}

	var replaceNodeWithFragment func(*nethtml.Node, string)
	replaceNodeWithFragment = func(n *nethtml.Node, content string) {
		fragment, parseErr := nethtml.ParseFragment(strings.NewReader(content), n.Parent)
		if parseErr != nil || len(fragment) == 0 {
			return
		}
		for _, child := range fragment {
			n.Parent.InsertBefore(child, n)
		}
		n.Parent.RemoveChild(n)
	}

	var walk func(*nethtml.Node)
	walk = func(n *nethtml.Node) {
		if n.Type == nethtml.ElementNode {
			tag := strings.ToLower(n.Data)

			// Skip style, script, and SVG children
			if tag == "style" || tag == "script" || tag == "svg" {
				return
			}

			// Case 1: <redact>...</redact> element
			if tag == "redact" {
				val := ""
				if n.FirstChild != nil && n.FirstChild.Type == nethtml.TextNode {
					val = n.FirstChild.Data
				}
				piiType := nodeAttr(n, "type")
				styleAttr := nodeAttr(n, "style")
				if styleAttr == "" {
					styleAttr = defaultReplacement
				}
				replacementSpan := renderRedactionSpan(val, piiType, styleAttr, customText)
				replaceNodeWithFragment(n, replacementSpan)
				return
			}

			// Case 2: Element with data-redact="true"
			if nodeAttr(n, "data-redact") == "true" {
				val := ""
				if n.FirstChild != nil && n.FirstChild.Type == nethtml.TextNode {
					val = n.FirstChild.Data
				}
				piiType := nodeAttr(n, "data-redact-type")
				styleAttr := nodeAttr(n, "data-redact-style")
				if styleAttr == "" {
					styleAttr = defaultReplacement
				}
				replacementSpan := renderRedactionSpan(val, piiType, styleAttr, customText)
				replaceNodeWithFragment(n, replacementSpan)
				return
			}
		}

		// Text node scrubbing under options.Redaction
		if n.Type == nethtml.TextNode && optionsActive && len(compiledPatterns) > 0 {
			origText := n.Data
			newText := origText
			modified := false

			for idx, pat := range compiledPatterns {
				pType := patternTypes[idx]
				if pat.MatchString(newText) {
					modified = true
					newText = pat.ReplaceAllStringFunc(newText, func(match string) string {
						return renderRedactionSpan(match, pType, defaultReplacement, customText)
					})
				}
			}

			if modified && newText != origText {
				replaceNodeWithFragment(n, newText)
				return
			}
		}

		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			walk(c)
			c = next
		}
	}

	walk(doc)

	var buf bytes.Buffer
	if err := nethtml.Render(&buf, doc); err != nil {
		return htmlStr
	}
	return buf.String()
}
