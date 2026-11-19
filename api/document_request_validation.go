package main

import (
	"fmt"
	"strconv"
	"strings"
)

func validateDocumentPageSettings(html, css string) error {
	if documentPageRulePattern.MatchString(html) || documentPageRulePattern.MatchString(css) {
		return documentRequestError(422, "document_page_settings_disallowed", "@page settings must be supplied through options")
	}
	return nil
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
	if len(options.HeaderTemplate) > maxDocumentTemplateBytes {
		return documentRequestError(413, "document_template_too_large", fmt.Sprintf("options.headerTemplate must not exceed %d bytes", maxDocumentTemplateBytes))
	}
	if len(options.FooterTemplate) > maxDocumentTemplateBytes {
		return documentRequestError(413, "document_template_too_large", fmt.Sprintf("options.footerTemplate must not exceed %d bytes", maxDocumentTemplateBytes))
	}
	if options.HeaderTemplate != "" {
		if err := validateDocumentSafety(options.HeaderTemplate, ""); err != nil {
			return err
		}
	}
	if options.FooterTemplate != "" {
		if err := validateDocumentSafety(options.FooterTemplate, ""); err != nil {
			return err
		}
	}
	if len(options.Password) > 128 {
		return documentRequestError(422, "document_password_invalid", "options.password must not exceed 128 characters")
	}
	if len(options.OwnerPassword) > 128 {
		return documentRequestError(422, "document_password_invalid", "options.ownerPassword must not exceed 128 characters")
	}
	if options.Permissions != "" {
		switch strings.ToLower(strings.TrimSpace(options.Permissions)) {
		case "all", "print", "none":
		default:
			return documentRequestError(422, "document_permissions_invalid", "options.permissions must be one of all, print, or none")
		}
	}
	if sel := options.getWaitForSelector(); len(sel) > 1024 {
		return documentRequestError(422, "document_wait_selector_invalid", "options.waitFor.selector must not exceed 1024 characters")
	}
	if fn := options.getWaitForFunction(); len(fn) > 4096 {
		return documentRequestError(422, "document_wait_function_invalid", "options.waitFor.function must not exceed 4096 characters")
	}
	if idle := options.getNetworkIdle(); idle != "" {
		switch strings.ToLower(strings.TrimSpace(idle)) {
		case "networkidle0", "networkidle2":
		default:
			return documentRequestError(422, "document_network_idle_invalid", "options.waitFor.networkIdle must be either \"networkidle0\" or \"networkidle2\"")
		}
	}
	if ms := options.getTimeoutMs(); ms < 0 || ms > 20000 {
		return documentRequestError(422, "document_wait_timeout_invalid", "options.waitFor.timeoutMs must be between 0 and 20000")
	}
	if options.PageNumbers != nil {
		pn := options.PageNumbers
		if len(pn.Format) > 256 {
			return documentRequestError(422, "document_page_number_format_invalid", "options.pageNumbers.format must not exceed 256 characters")
		}
		if pn.Format != "" && !strings.Contains(pn.Format, "{page}") {
			return documentRequestError(422, "document_page_number_format_invalid", "options.pageNumbers.format must contain '{page}' placeholder")
		}
		if pn.StartPage < 0 {
			return documentRequestError(422, "document_page_number_start_page_invalid", "options.pageNumbers.startPage must be >= 0")
		}
		if pn.StartNumber < 0 {
			return documentRequestError(422, "document_page_number_start_number_invalid", "options.pageNumbers.startNumber must be >= 0")
		}
		if pn.FontSize < 0 || pn.FontSize > 72 {
			return documentRequestError(422, "document_page_number_font_size_invalid", "options.pageNumbers.fontSize must be between 1 and 72")
		}
		if pn.Position != "" {
			switch strings.ToLower(strings.TrimSpace(pn.Position)) {
			case "bottom-center", "bottom-right", "bottom-left", "top-center", "top-right", "top-left":
			default:
				return documentRequestError(422, "document_page_number_position_invalid", "options.pageNumbers.position must be one of: bottom-center, bottom-right, bottom-left, top-center, top-right, top-left")
			}
		}
		if pn.Color != "" {
			colorStr := strings.TrimSpace(pn.Color)
			if strings.HasPrefix(colorStr, "#") {
				if len(colorStr) != 7 {
					return documentRequestError(422, "document_page_number_color_invalid", "options.pageNumbers.color hex must be #RRGGBB format")
				}
			} else {
				parts := strings.Fields(colorStr)
				if len(parts) != 3 {
					return documentRequestError(422, "document_page_number_color_invalid", "options.pageNumbers.color must be 3 RGB floats (e.g. '0.2 0.2 0.2') or hex (#RRGGBB)")
				}
				for _, p := range parts {
					val, err := strconv.ParseFloat(p, 64)
					if err != nil || val < 0 || val > 1 {
						return documentRequestError(422, "document_page_number_color_invalid", "options.pageNumbers.color RGB components must be floats between 0.0 and 1.0")
					}
				}
			}
		}
	}
	if options.Watermark != nil {
		wm := options.Watermark
		text := strings.TrimSpace(wm.Text)
		if text == "" {
			return documentRequestError(422, "document_watermark_text_required", "options.watermark.text is required")
		}
		if len(text) > 256 {
			return documentRequestError(422, "document_watermark_text_too_large", "options.watermark.text must not exceed 256 characters")
		}
		if wm.Opacity != nil {
			if *wm.Opacity < 0.0 || *wm.Opacity > 1.0 {
				return documentRequestError(422, "document_watermark_opacity_invalid", "options.watermark.opacity must be between 0.0 and 1.0")
			}
		}
		if wm.FontSize < 0 || wm.FontSize > 144 {
			return documentRequestError(422, "document_watermark_font_size_invalid", "options.watermark.fontSize must be between 1 and 144")
		}
		if wm.Rotation != nil {
			if *wm.Rotation < -360 || *wm.Rotation > 360 {
				return documentRequestError(422, "document_watermark_rotation_invalid", "options.watermark.rotation must be between -360 and 360")
			}
		}
		if wm.Color != "" {
			if _, err := parseColorDesc(wm.Color); err != nil {
				return documentRequestError(422, "document_watermark_color_invalid", "options.watermark.color must be 3 RGB floats (e.g. '0.5 0.5 0.5') or hex (#RRGGBB)")
			}
		}
		if wm.Position != "" {
			switch strings.ToLower(strings.TrimSpace(wm.Position)) {
			case "center", "top-center", "top-left", "top-right", "bottom-center", "bottom-left", "bottom-right":
			default:
				return documentRequestError(422, "document_watermark_position_invalid", "options.watermark.position must be one of: center, top-center, top-left, top-right, bottom-center, bottom-left, bottom-right")
			}
		}
		if wm.Font != "" {
			switch strings.ToLower(strings.TrimSpace(wm.Font)) {
			case "helvetica", "times-roman", "courier", "times":
			default:
				return documentRequestError(422, "document_watermark_font_invalid", "options.watermark.font must be one of: Helvetica, Times-Roman, Courier")
			}
		}
	}
	if options.Compliance != nil {
		c := options.Compliance
		prof := strings.ToLower(strings.TrimSpace(c.Profile))
		if prof == "" {
			return documentRequestError(422, "document_compliance_profile_required", "options.compliance.profile is required")
		}
		switch prof {
		case "pdfa-1b", "pdfa1b", "pdfa-2b", "pdfa2b", "pdfa-3b", "pdfa3b", "factur-x", "facturx", "zugferd", "zugferd2":
		default:
			return documentRequestError(422, "document_compliance_profile_invalid", "options.compliance.profile must be one of: pdfa-1b, pdfa-2b, pdfa-3b, factur-x, zugferd")
		}
		if strings.HasPrefix(prof, "factur") || strings.HasPrefix(prof, "zugferd") {
			if strings.TrimSpace(c.InvoiceXML) == "" {
				return documentRequestError(422, "document_compliance_xml_required", "options.compliance.invoiceXml is required for factur-x and zugferd profiles")
			}
		}
		if c.InvoiceXML != "" {
			if len(c.InvoiceXML) > 5242880 {
				return documentRequestError(422, "document_compliance_xml_too_large", "options.compliance.invoiceXml must not exceed 5MB")
			}
		}
		if c.InvoiceProfile != "" {
			switch strings.ToUpper(strings.TrimSpace(c.InvoiceProfile)) {
			case "MINIMUM", "BASIC WL", "BASICWL", "BASIC-WL", "BASIC", "EN 16931", "EN16931", "COMFORT", "EXTENDED":
			default:
				return documentRequestError(422, "document_compliance_invoice_profile_invalid", "options.compliance.invoiceProfile must be one of: MINIMUM, BASIC WL, BASIC, EN 16931, EXTENDED")
			}
		}
		if c.XMLFilename != "" {
			fn := strings.TrimSpace(c.XMLFilename)
			if len(fn) > 256 || strings.ContainsAny(fn, `/\:*?"<>|`) {
				return documentRequestError(422, "document_compliance_filename_invalid", "options.compliance.xmlFilename is invalid")
			}
		}
		if options.Password != "" || options.OwnerPassword != "" {
			return documentRequestError(422, "document_compliance_encrypted_unsupported", "PDF/A and Factur-X/ZUGFeRD compliance does not allow password-protected or encrypted PDF documents")
		}
	}
	if options.ResponseFormat != "" {
		switch strings.ToLower(strings.TrimSpace(options.ResponseFormat)) {
		case "json", "binary", "pdf":
		default:
			return documentRequestError(422, "document_response_format_invalid", "options.responseFormat must be one of json, binary, or pdf")
		}
	}
	return nil
}
