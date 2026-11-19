package main

import (
	"fmt"
	"net"
	"net/textproto"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

const (
	maxURLCustomHeaders     = 32
	maxURLCustomHeaderBytes = 8192
	maxURLCustomCookies     = 32
	maxURLCustomCookieBytes = 8192
)

var httpTokenPattern = regexp.MustCompile("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$")

var disallowedURLHeaderNames = map[string]bool{
	"host":                true,
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"proxy-connection":    true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
	"content-length":      true,
	"expect":              true,
	"x-forwarded-for":     true,
	"x-forwarded-host":    true,
	"x-forwarded-proto":   true,
	"x-forwarded-port":    true,
	"x-real-ip":           true,
	"x-original-url":      true,
	"x-rewrite-url":       true,
	"cf-connecting-ip":    true,
	"true-client-ip":      true,
	"forwarded":           true,
	"via":                 true,
	"x-amzn-trace-id":     true,
	"x-amz-cf-id":         true,
}

type urlCookie struct {
	Name     string `json:"name"`
	Value    string `json:"value"`
	Domain   string `json:"domain,omitempty"`
	Path     string `json:"path,omitempty"`
	Secure   *bool  `json:"secure,omitempty"`
	HTTPOnly *bool  `json:"httpOnly,omitempty"`
	SameSite string `json:"sameSite,omitempty"`
}

func urlAuthHeadersEnabled() bool {
	raw := strings.TrimSpace(os.Getenv("URL_AUTH_HEADERS_ENABLED"))
	if raw == "" {
		return true
	}
	val, err := strconv.ParseBool(raw)
	if err != nil {
		return true
	}
	return val
}

func validateRenderURL(rawURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed == nil || parsed.Host == "" {
		return "", fmt.Errorf("url must be a valid absolute HTTP(S) URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("url must use http or https")
	}
	if parsed.User != nil {
		return "", fmt.Errorf("url must not contain credentials")
	}
	if port := parsed.Port(); port != "" && port != "80" && port != "443" {
		return "", fmt.Errorf("url must use port 80 or 443")
	}

	host := parsed.Hostname()
	if host == "" || strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return "", fmt.Errorf("url must target a public host")
	}

	addresses := []net.IP{net.ParseIP(host)}
	if addresses[0] == nil {
		addresses, err = net.LookupIP(host)
		if err != nil || len(addresses) == 0 {
			return "", fmt.Errorf("url host could not be resolved")
		}
	}
	for _, address := range addresses {
		if !isPublicIP(address) {
			return "", fmt.Errorf("url must target a public host")
		}
	}

	return parsed.String(), nil
}

func isPublicIP(address net.IP) bool {
	return !isBlockedIP(address)
}

func validateAndScrubURLHeaders(targetURL string, headers map[string]string) (map[string]string, error) {
	if len(headers) == 0 {
		return nil, nil
	}
	if !urlAuthHeadersEnabled() {
		return nil, &renderError{
			Code:    "url_headers_disabled",
			Message: "Custom URL headers and cookies are disabled",
			Status:  422,
		}
	}
	if len(headers) > maxURLCustomHeaders {
		return nil, &renderError{
			Code:    "url_headers_too_large",
			Message: fmt.Sprintf("source.headers must not exceed %d entries", maxURLCustomHeaders),
			Status:  422,
		}
	}

	scrubbed := make(map[string]string, len(headers))
	seenLower := make(map[string]bool, len(headers))
	totalBytes := 0

	for rawKey, val := range headers {
		if strings.ContainsAny(rawKey, "\r\n\x00") || strings.ContainsAny(val, "\r\n\x00") {
			return nil, &renderError{
				Code:    "url_header_invalid",
				Message: "source.headers must not contain CRLF or null control characters",
				Status:  422,
			}
		}
		key := strings.TrimSpace(rawKey)
		if key == "" || key != rawKey || !httpTokenPattern.MatchString(key) {
			return nil, &renderError{
				Code:    "url_header_invalid",
				Message: fmt.Sprintf("invalid HTTP header name %q", rawKey),
				Status:  422,
			}
		}
		for i := 0; i < len(val); i++ {
			b := val[i]
			if (b < 0x20 && b != '\t') || b == 0x7f {
				return nil, &renderError{
					Code:    "url_header_invalid",
					Message: fmt.Sprintf("header %q contains invalid control characters", rawKey),
					Status:  422,
				}
			}
		}

		lowerKey := strings.ToLower(key)
		if disallowedURLHeaderNames[lowerKey] || strings.HasPrefix(lowerKey, "proxy-") || strings.HasPrefix(lowerKey, "sec-") {
			return nil, &renderError{
				Code:    "url_header_disallowed",
				Message: fmt.Sprintf("header %q is not permitted on URL renders", rawKey),
				Status:  422,
			}
		}
		if seenLower[lowerKey] {
			return nil, &renderError{
				Code:    "url_header_invalid",
				Message: fmt.Sprintf("duplicate header name %q", rawKey),
				Status:  422,
			}
		}
		seenLower[lowerKey] = true

		totalBytes += len(key) + len(val)
		if totalBytes > maxURLCustomHeaderBytes {
			return nil, &renderError{
				Code:    "url_headers_too_large",
				Message: fmt.Sprintf("source.headers total size must not exceed %d bytes", maxURLCustomHeaderBytes),
				Status:  422,
			}
		}

		canonicalKey := textproto.CanonicalMIMEHeaderKey(key)
		scrubbed[canonicalKey] = val
	}

	return scrubbed, nil
}

func validateURLCookies(targetURL string, cookies []urlCookie) ([]urlCookie, error) {
	if len(cookies) == 0 {
		return nil, nil
	}
	if !urlAuthHeadersEnabled() {
		return nil, &renderError{
			Code:    "url_headers_disabled",
			Message: "Custom URL headers and cookies are disabled",
			Status:  422,
		}
	}
	if len(cookies) > maxURLCustomCookies {
		return nil, &renderError{
			Code:    "url_cookies_too_large",
			Message: fmt.Sprintf("source.cookies must not exceed %d entries", maxURLCustomCookies),
			Status:  422,
		}
	}

	parsedTarget, err := url.Parse(strings.TrimSpace(targetURL))
	if err != nil || parsedTarget == nil || parsedTarget.Hostname() == "" {
		return nil, &renderError{
			Code:    "url_cookie_domain_invalid",
			Message: "target URL is invalid for cookies",
			Status:  422,
		}
	}
	targetHost := strings.ToLower(parsedTarget.Hostname())

	validated := make([]urlCookie, 0, len(cookies))
	totalBytes := 0

	for _, c := range cookies {
		if strings.ContainsAny(c.Name, ";,\r\n\x00 \t") || strings.ContainsAny(c.Value, ";\r\n\x00") {
			return nil, &renderError{
				Code:    "url_cookie_invalid",
				Message: "cookie name and value must not contain semicolons or control characters",
				Status:  422,
			}
		}
		name := strings.TrimSpace(c.Name)
		if name == "" || name != c.Name || !httpTokenPattern.MatchString(name) {
			return nil, &renderError{
				Code:    "url_cookie_invalid",
				Message: fmt.Sprintf("invalid cookie name %q", c.Name),
				Status:  422,
			}
		}
		for i := 0; i < len(c.Value); i++ {
			b := c.Value[i]
			if (b < 0x20 && b != '\t') || b == 0x7f {
				return nil, &renderError{
					Code:    "url_cookie_invalid",
					Message: fmt.Sprintf("cookie %q value contains invalid control characters", c.Name),
					Status:  422,
				}
			}
		}

		domain := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(c.Domain), "."))
		if domain == "" {
			domain = targetHost
		}
		if strings.ContainsAny(domain, ";/\r\n\x00 \t:") {
			return nil, &renderError{
				Code:    "url_cookie_domain_invalid",
				Message: fmt.Sprintf("invalid cookie domain %q", c.Domain),
				Status:  422,
			}
		}
		if domain == "localhost" || strings.HasSuffix(domain, ".localhost") || strings.HasSuffix(domain, ".local") {
			return nil, &renderError{
				Code:    "url_cookie_domain_invalid",
				Message: "cookie domain must target a public host matching the URL",
				Status:  422,
			}
		}
		if ip := net.ParseIP(domain); ip != nil {
			if isBlockedIP(ip) || domain != targetHost {
				return nil, &renderError{
					Code:    "url_cookie_domain_invalid",
					Message: "cookie IP domain must match the target public IP",
					Status:  422,
				}
			}
		} else if altIP := parseAlternativeIP(domain); altIP != nil {
			return nil, &renderError{
				Code:    "url_cookie_domain_invalid",
				Message: "cookie domain must not use alternative IP encodings",
				Status:  422,
			}
		} else {
			isExactMatch := domain == targetHost
			isParentDomain := strings.HasSuffix(targetHost, "."+domain) && strings.Count(domain, ".") >= 1
			if !isExactMatch && !isParentDomain {
				return nil, &renderError{
					Code:    "url_cookie_domain_invalid",
					Message: fmt.Sprintf("cookie domain %q does not match target host %q", c.Domain, targetHost),
					Status:  422,
				}
			}
		}

		path := strings.TrimSpace(c.Path)
		if path == "" {
			path = "/"
		}
		if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, ";\r\n\x00") {
			return nil, &renderError{
				Code:    "url_cookie_invalid",
				Message: "cookie path must start with '/' and not contain control characters",
				Status:  422,
			}
		}

		sameSite := strings.TrimSpace(c.SameSite)
		if sameSite != "" {
			switch strings.ToLower(sameSite) {
			case "strict":
				sameSite = "Strict"
			case "lax":
				sameSite = "Lax"
			case "none":
				sameSite = "None"
			default:
				return nil, &renderError{
					Code:    "url_cookie_invalid",
					Message: "cookie sameSite must be Strict, Lax, or None",
					Status:  422,
				}
			}
		}

		totalBytes += len(name) + len(c.Value) + len(domain) + len(path)
		if totalBytes > maxURLCustomCookieBytes {
			return nil, &renderError{
				Code:    "url_cookies_too_large",
				Message: fmt.Sprintf("source.cookies total size must not exceed %d bytes", maxURLCustomCookieBytes),
				Status:  422,
			}
		}

		validated = append(validated, urlCookie{
			Name:     name,
			Value:    c.Value,
			Domain:   domain,
			Path:     path,
			Secure:   c.Secure,
			HTTPOnly: c.HTTPOnly,
			SameSite: sameSite,
		})
	}

	return validated, nil
}

func effectiveURLPort(u *url.URL) string {
	if u == nil {
		return ""
	}
	if p := u.Port(); p != "" {
		return p
	}
	switch strings.ToLower(u.Scheme) {
	case "http":
		return "80"
	case "https":
		return "443"
	default:
		return ""
	}
}

// isSameOriginHeaderTarget ensures custom HTTP headers are only attached to requests
// matching the exact (scheme, host, port) origin of the initial target URL.
// This prevents leaking Authorization tokens or custom headers to third-party subresources
// or across HTTPS -> HTTP scheme downgrades.
func isSameOriginHeaderTarget(targetURL, requestURL string) bool {
	tParsed, err1 := url.Parse(strings.TrimSpace(targetURL))
	rParsed, err2 := url.Parse(strings.TrimSpace(requestURL))
	if err1 != nil || err2 != nil || tParsed == nil || rParsed == nil {
		return false
	}
	tScheme := strings.ToLower(tParsed.Scheme)
	rScheme := strings.ToLower(rParsed.Scheme)
	if (tScheme != "http" && tScheme != "https") || tScheme != rScheme {
		return false
	}
	tHost := strings.ToLower(tParsed.Hostname())
	rHost := strings.ToLower(rParsed.Hostname())
	if tHost == "" || tHost != rHost {
		return false
	}
	return effectiveURLPort(tParsed) == effectiveURLPort(rParsed)
}
