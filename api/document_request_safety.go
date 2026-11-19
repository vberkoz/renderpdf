package main

import (
	"fmt"
	"net/url"
	"strings"

	nethtml "golang.org/x/net/html"
)

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
