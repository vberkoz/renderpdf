package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	stdhtml "html"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

var bcp47LanguagePattern = regexp.MustCompile(`^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$`)

// complianceOptions configures archival (PDF/A), universal accessibility (PDF/UA-1),
// and European e-invoicing (Factur-X / ZUGFeRD KoSIT EN 16931) compliance.
type complianceOptions struct {
	Profile        string `json:"profile"`                  // "pdfa-1b", "pdfa-2b", "pdfa-3b", "pdfua-1", "factur-x", "zugferd"
	InvoiceXML     string `json:"invoiceXml,omitempty"`     // Raw XML string or base64-encoded XML
	InvoiceProfile string `json:"invoiceProfile,omitempty"` // "MINIMUM", "BASIC WL", "BASIC", "EN 16931", "EXTENDED" (default: "EN 16931")
	XMLFilename    string `json:"xmlFilename,omitempty"`    // e.g. "factur-x.xml" (default) or "zugferd-invoice.xml"
	DocumentType   string `json:"documentType,omitempty"`   // default "INVOICE"
	Version        string `json:"version,omitempty"`        // default "1.0"
	PDFUA          *bool  `json:"pdfua,omitempty"`          // Enables PDF/UA-1 tagging & pdfuaid:part metadata
	Title          string `json:"title,omitempty"`          // Document title for dc:title, /Info /Title, and /DisplayDocTitle
	Language       string `json:"language,omitempty"`       // BCP-47 language tag for Catalog /Lang (default "en-US")
	ValidateXML    *bool  `json:"validateXml,omitempty"`    // Enforces KoSIT EN 16931 CII XML validation
}

func (c *complianceOptions) isPDFUA() bool {
	if c == nil {
		return false
	}
	if c.PDFUA != nil && *c.PDFUA {
		return true
	}
	p := strings.ToLower(strings.TrimSpace(c.Profile))
	return p == "pdfua-1" || p == "pdfua1" || p == "pdfua"
}

func complianceEngineV2Enabled() bool {
	raw := strings.TrimSpace(os.Getenv("COMPLIANCE_ENGINE_V2"))
	if raw == "" {
		return true
	}
	val, err := strconv.ParseBool(raw)
	if err != nil {
		return true
	}
	return val
}

func complianceStrictXMLEnabled() bool {
	raw := strings.TrimSpace(os.Getenv("COMPLIANCE_STRICT_XML"))
	if raw == "" {
		return true
	}
	val, err := strconv.ParseBool(raw)
	if err != nil {
		return true
	}
	return val
}

// decodeInvoiceXML handles raw XML strings or base64 encoded XML content.
func decodeInvoiceXML(raw string) ([]byte, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, fmt.Errorf("invoice XML content cannot be empty")
	}

	if strings.HasPrefix(trimmed, "<") {
		return []byte(trimmed), nil
	}

	// Attempt base64 decoding
	if decoded, err := base64.StdEncoding.DecodeString(trimmed); err == nil && len(decoded) > 0 {
		return decoded, nil
	}
	if decoded, err := base64.URLEncoding.DecodeString(trimmed); err == nil && len(decoded) > 0 {
		return decoded, nil
	}

	return []byte(trimmed), nil
}

type parsedCIIInvoice struct {
	RootLocal             string
	RootSpace             string
	HasContext            bool
	GuidelineID           string
	HasExchangedDocument  bool
	DocumentID            string
	TypeCode              string
	IssueDateTime         string
	HasTradeTransaction   bool
	DirectChildElements   int
}

func parseXMLStructure(xmlBytes []byte) (parsedCIIInvoice, error) {
	var info parsedCIIInvoice
	trimmed := bytes.TrimSpace(xmlBytes)
	if len(trimmed) == 0 {
		return info, fmt.Errorf("XML payload is empty")
	}
	decoder := xml.NewDecoder(bytes.NewReader(trimmed))
	var stack []string
	for {
		tok, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return info, fmt.Errorf("malformed XML: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			local := t.Name.Local
			if idx := strings.LastIndex(local, ":"); idx != -1 {
				local = local[idx+1:]
			}
			if len(stack) == 0 {
				info.RootLocal = local
				info.RootSpace = t.Name.Space
				for _, attr := range t.Attr {
					if (attr.Name.Local == "xmlns" || attr.Name.Space == "xmlns" || strings.HasPrefix(attr.Name.Local, "xmlns:")) &&
						strings.Contains(attr.Value, "CrossIndustryInvoice") {
						info.RootSpace = attr.Value
					}
				}
			} else if len(stack) == 1 {
				info.DirectChildElements++
				switch local {
				case "ExchangedDocumentContext":
					info.HasContext = true
				case "ExchangedDocument":
					info.HasExchangedDocument = true
				case "SupplyChainTradeTransaction":
					info.HasTradeTransaction = true
				}
			}
			stack = append(stack, local)
		case xml.CharData:
			text := strings.TrimSpace(string(t))
			if text == "" || len(stack) < 3 {
				continue
			}
			leaf := stack[len(stack)-1]
			parent := stack[len(stack)-2]
			if stack[1] == "ExchangedDocumentContext" && leaf == "ID" && parent == "GuidelineSpecifiedDocumentContextParameter" {
				if info.GuidelineID == "" {
					info.GuidelineID = text
				}
			}
			if stack[1] == "ExchangedDocument" {
				switch {
				case parent == "ExchangedDocument" && leaf == "ID":
					if info.DocumentID == "" {
						info.DocumentID = text
					}
				case parent == "ExchangedDocument" && leaf == "TypeCode":
					if info.TypeCode == "" {
						info.TypeCode = text
					}
				case (parent == "IssueDateTime" || leaf == "DateTimeString") && info.IssueDateTime == "":
					info.IssueDateTime = text
				}
			}
		case xml.EndElement:
			if len(stack) == 0 {
				return info, fmt.Errorf("unexpected closing tag")
			}
			stack = stack[:len(stack)-1]
		}
	}
	if len(stack) != 0 {
		return info, fmt.Errorf("unclosed XML element %q", stack[len(stack)-1])
	}
	if info.RootLocal == "" {
		return info, fmt.Errorf("XML payload contains no root element")
	}
	return info, nil
}

// validateKoSITEN16931XML validates a Factur-X / ZUGFeRD UN/CEFACT CrossIndustryInvoice
// XML payload against KoSIT EN 16931 CII structural requirements.
func validateKoSITEN16931XML(xmlBytes []byte, invoiceProfile string) error {
	info, err := parseXMLStructure(xmlBytes)
	if err != nil {
		return err
	}
	if info.RootLocal != "CrossIndustryInvoice" {
		return fmt.Errorf("root element must be CrossIndustryInvoice, got %q", info.RootLocal)
	}
	if !info.HasContext {
		return fmt.Errorf("missing required CII element ExchangedDocumentContext")
	}
	if !info.HasExchangedDocument {
		return fmt.Errorf("missing required CII element ExchangedDocument")
	}
	if strings.TrimSpace(info.DocumentID) == "" {
		return fmt.Errorf("missing required CII element ExchangedDocument/ID")
	}
	if !info.HasTradeTransaction {
		return fmt.Errorf("missing required CII element SupplyChainTradeTransaction")
	}
	return nil
}

// validateFacturXInvoiceXML always rejects malformed XML and enforces full KoSIT EN 16931
// CII rules when the standard CII namespace is declared with child elements or when
// validateXml is explicitly set to true.
func validateFacturXInvoiceXML(xmlBytes []byte, invoiceProfile string, explicitValidate *bool) error {
	info, err := parseXMLStructure(xmlBytes)
	if err != nil {
		return err
	}
	if explicitValidate != nil && !*explicitValidate {
		return nil
	}
	strict := explicitValidate != nil && *explicitValidate
	if !strict && !complianceStrictXMLEnabled() {
		return nil
	}
	isStandardCIINamespace := info.RootLocal == "CrossIndustryInvoice" &&
		info.RootSpace == "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" &&
		info.DirectChildElements > 0
	if strict || isStandardCIINamespace {
		return validateKoSITEN16931XML(xmlBytes, invoiceProfile)
	}
	return nil
}

// buildMinimalSRGBICCProfile constructs a valid, self-contained 3-channel ("RGB ")
// sRGB IEC61966-2.1 ICC v2.1.0 color profile binary payload with an "acsp" header
// and required tags (desc, cprt, wtpt, rXYZ, gXYZ, bXYZ, rTRC, gTRC, bTRC) for VeraPDF.
func buildMinimalSRGBICCProfile() []byte {
	type iccTag struct {
		sig  string
		data []byte
	}

	makeXYZTag := func(x, y, z uint32) []byte {
		b := make([]byte, 20)
		copy(b[0:4], "XYZ ")
		binary.BigEndian.PutUint32(b[8:12], x)
		binary.BigEndian.PutUint32(b[12:16], y)
		binary.BigEndian.PutUint32(b[16:20], z)
		return b
	}

	makeCurvTag := func(gamma8Fixed8 uint16) []byte {
		b := make([]byte, 14)
		copy(b[0:4], "curv")
		binary.BigEndian.PutUint32(b[8:12], 1)
		binary.BigEndian.PutUint16(b[12:14], gamma8Fixed8)
		return b
	}

	makeDescTag := func(ascii string) []byte {
		strBytes := append([]byte(ascii), 0)
		b := make([]byte, 12+len(strBytes)+67)
		copy(b[0:4], "desc")
		binary.BigEndian.PutUint32(b[8:12], uint32(len(strBytes)))
		copy(b[12:12+len(strBytes)], strBytes)
		return b
	}

	makeTextTag := func(ascii string) []byte {
		strBytes := append([]byte(ascii), 0)
		b := make([]byte, 8+len(strBytes))
		copy(b[0:4], "text")
		copy(b[8:], strBytes)
		return b
	}

	trcData := makeCurvTag(0x0233) // ~2.2 gamma
	tags := []iccTag{
		{sig: "desc", data: makeDescTag("sRGB IEC61966-2.1")},
		{sig: "cprt", data: makeTextTag("Copyright RenderPDF")},
		{sig: "wtpt", data: makeXYZTag(0x0000f351, 0x00010000, 0x000116cc)},
		{sig: "rXYZ", data: makeXYZTag(0x00006fa2, 0x000038f5, 0x00000390)},
		{sig: "gXYZ", data: makeXYZTag(0x00006299, 0x0000b785, 0x000018da)},
		{sig: "bXYZ", data: makeXYZTag(0x000024a0, 0x00000f84, 0x0000b6cf)},
		{sig: "rTRC", data: trcData},
		{sig: "gTRC", data: trcData},
		{sig: "bTRC", data: trcData},
	}

	tagTableSize := 4 + len(tags)*12
	dataOffset := 128 + tagTableSize
	if rem := dataOffset % 4; rem != 0 {
		dataOffset += 4 - rem
	}

	var dataBuf bytes.Buffer
	type tagEntry struct {
		sig    string
		offset uint32
		size   uint32
	}
	entries := make([]tagEntry, len(tags))
	for i, t := range tags {
		off := uint32(dataOffset + dataBuf.Len())
		sz := uint32(len(t.data))
		entries[i] = tagEntry{sig: t.sig, offset: off, size: sz}
		dataBuf.Write(t.data)
		for dataBuf.Len()%4 != 0 {
			dataBuf.WriteByte(0)
		}
	}

	totalSize := uint32(dataOffset + dataBuf.Len())
	profile := make([]byte, totalSize)

	// 128-byte ICC Profile Header
	binary.BigEndian.PutUint32(profile[0:4], totalSize)
	copy(profile[4:8], "lcms")
	binary.BigEndian.PutUint32(profile[8:12], 0x02100000) // Version 2.1.0
	copy(profile[12:16], "mntr")                          // Device class: Display
	copy(profile[16:20], "RGB ")                          // Color space: 3-component RGB
	copy(profile[20:24], "XYZ ")                          // PCS: XYZ
	binary.BigEndian.PutUint16(profile[24:26], 2026)      // Year
	binary.BigEndian.PutUint16(profile[26:28], 1)         // Month
	binary.BigEndian.PutUint16(profile[28:30], 1)         // Day
	copy(profile[36:40], "acsp")                          // Profile file signature
	copy(profile[40:44], "APPL")                          // Primary platform
	// PCS Illuminant D50 (X=0.9642, Y=1.0000, Z=0.8249)
	binary.BigEndian.PutUint32(profile[68:72], 0x0000f6d6)
	binary.BigEndian.PutUint32(profile[72:76], 0x00010000)
	binary.BigEndian.PutUint32(profile[76:80], 0x0000d32d)
	copy(profile[80:84], "RPDF")

	// Tag table
	binary.BigEndian.PutUint32(profile[128:132], uint32(len(entries)))
	for i, e := range entries {
		pos := 132 + i*12
		copy(profile[pos:pos+4], e.sig)
		binary.BigEndian.PutUint32(profile[pos+4:pos+8], e.offset)
		binary.BigEndian.PutUint32(profile[pos+8:pos+12], e.size)
	}

	copy(profile[dataOffset:], dataBuf.Bytes())
	return profile
}

// buildXMPMetadata constructs a legacy v1 XMP metadata stream for backward compatibility.
func buildXMPMetadata(part int, conformance string, isFacturX bool, fxDocFileName, fxDocType, fxVersion, fxConformanceLevel string) string {
	return buildXMPMetadataWithOptions(part, conformance, part > 0, false, isFacturX, "RenderPDF Compliant Document", fxDocFileName, fxDocType, fxVersion, fxConformanceLevel, time.Now().UTC(), false)
}

func buildXMPMetadataWithOptions(
	part int,
	conformance string,
	hasPDFA bool,
	hasPDFUA bool,
	isFacturX bool,
	docTitle string,
	fxDocFileName, fxDocType, fxVersion, fxConformanceLevel string,
	timestamp time.Time,
	v2 bool,
) string {
	now := timestamp.UTC().Format(time.RFC3339)
	if strings.TrimSpace(docTitle) == "" {
		docTitle = "RenderPDF Compliant Document"
	}
	var sb strings.Builder

	sb.WriteString(`<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`)

	if hasPDFA {
		sb.WriteString(`
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>` + strconv.Itoa(part) + `</pdfaid:part>
      <pdfaid:conformance>` + stdhtml.EscapeString(conformance) + `</pdfaid:conformance>
    </rdf:Description>`)
	}

	if hasPDFUA {
		sb.WriteString(`
    <rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">
      <pdfuaid:part>1</pdfuaid:part>
    </rdf:Description>`)
	}

	if v2 {
		escapedTitle := stdhtml.EscapeString(docTitle)
		sb.WriteString(`
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">` + escapedTitle + `</rdf:li>
        </rdf:Alt>
      </dc:title>
      <dc:creator>
        <rdf:Seq>
          <rdf:li>RenderPDF</rdf:li>
        </rdf:Seq>
      </dc:creator>
      <dc:description>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">` + escapedTitle + `</rdf:li>
        </rdf:Alt>
      </dc:description>
    </rdf:Description>`)
	}

	sb.WriteString(`
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>RenderPDF Compliance Engine</pdf:Producer>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>RenderPDF</xmp:CreatorTool>
      <xmp:CreateDate>` + now + `</xmp:CreateDate>
      <xmp:ModifyDate>` + now + `</xmp:ModifyDate>
    </rdf:Description>`)

	if isFacturX || (v2 && hasPDFA && hasPDFUA) {
		sb.WriteString(`
    <rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
      <pdfaExtension:schemas>
        <rdf:Bag>`)
		if isFacturX {
			sb.WriteString(`
          <rdf:li rdf:parseType="Resource">
            <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
            <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
            <pdfaSchema:prefix>fx</pdfaSchema:prefix>
            <pdfaSchema:property>
              <rdf:Seq>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>DocumentFileName</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:description>name of the embedded XML invoice file</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>DocumentType</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:description>INVOICE</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>Version</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:description>The actual version of the ZUGFeRD/Factur-X XML schema</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>ConformanceLevel</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:description>The conformance level of the embedded XML invoice file</pdfaProperty:description>
                </rdf:li>
              </rdf:Seq>
            </pdfaSchema:property>
          </rdf:li>`)
		}
		if v2 && hasPDFUA {
			sb.WriteString(`
          <rdf:li rdf:parseType="Resource">
            <pdfaSchema:schema>PDF/UA Universal Accessibility Schema</pdfaSchema:schema>
            <pdfaSchema:namespaceURI>http://www.aiim.org/pdfua/ns/id/</pdfaSchema:namespaceURI>
            <pdfaSchema:prefix>pdfuaid</pdfaSchema:prefix>
            <pdfaSchema:property>
              <rdf:Seq>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>part</pdfaProperty:name>
                  <pdfaProperty:valueType>Integer</pdfaProperty:valueType>
                  <pdfaProperty:description>Indicates which part of ISO 14289 standard is followed</pdfaProperty:description>
                </rdf:li>
              </rdf:Seq>
            </pdfaSchema:property>
          </rdf:li>`)
		}
		sb.WriteString(`
        </rdf:Bag>
      </pdfaExtension:schemas>
    </rdf:Description>`)
	}

	if isFacturX {
		sb.WriteString(`
    <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
      <fx:DocumentFileName>` + stdhtml.EscapeString(fxDocFileName) + `</fx:DocumentFileName>
      <fx:DocumentType>` + stdhtml.EscapeString(fxDocType) + `</fx:DocumentType>
      <fx:Version>` + stdhtml.EscapeString(fxVersion) + `</fx:Version>
      <fx:ConformanceLevel>` + stdhtml.EscapeString(fxConformanceLevel) + `</fx:ConformanceLevel>
    </rdf:Description>`)
	}

	sb.WriteString(`
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`)

	return sb.String()
}

func formatPDFDate(t time.Time) string {
	return t.UTC().Format("D:20060102150405Z00'00'")
}

// applyPDFCompliance converts a rendered PDF into an archival PDF/A-1b, PDF/A-2b,
// PDF/A-3b, PDF/UA-1, or European e-invoicing Factur-X / ZUGFeRD compliant document.
func applyPDFCompliance(pdfBytes []byte, options documentRenderOptions) ([]byte, error) {
	if options.Compliance == nil {
		return pdfBytes, nil
	}

	opts := options.Compliance
	profile := strings.ToLower(strings.TrimSpace(opts.Profile))
	if profile == "" {
		return pdfBytes, nil
	}

	v2 := complianceEngineV2Enabled()
	part := 3
	conformance := "B"
	outputIntentS := "GTS_PDFA1"
	headerVersion := model.V17
	hasPDFA := true
	hasPDFUA := opts.isPDFUA()
	isFacturX := false

	switch profile {
	case "pdfa-1b", "pdfa1b":
		part = 1
		conformance = "B"
		outputIntentS = "GTS_PDFA1"
		headerVersion = model.V14
	case "pdfa-2b", "pdfa2b":
		part = 2
		conformance = "B"
		if !v2 {
			outputIntentS = "GTS_PDFA2"
		}
		headerVersion = model.V17
	case "pdfa-3b", "pdfa3b":
		part = 3
		conformance = "B"
		if !v2 {
			outputIntentS = "GTS_PDFA3"
		}
		headerVersion = model.V17
	case "factur-x", "facturx", "zugferd", "zugferd2":
		part = 3
		conformance = "B"
		if !v2 {
			outputIntentS = "GTS_PDFA3"
		}
		headerVersion = model.V17
		isFacturX = true
	case "pdfua-1", "pdfua1", "pdfua":
		if !v2 {
			return nil, fmt.Errorf("unsupported compliance profile %q when COMPLIANCE_ENGINE_V2 is disabled", opts.Profile)
		}
		hasPDFA = false
		hasPDFUA = true
		headerVersion = model.V17
	default:
		return nil, fmt.Errorf("unsupported compliance profile %q", opts.Profile)
	}

	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed

	rs := bytes.NewReader(pdfBytes)
	ctx, err := api.ReadValidateAndOptimize(rs, conf)
	if err != nil {
		return nil, fmt.Errorf("compliance parse pdf: %w", err)
	}

	xRefTable := ctx.XRefTable
	now := time.Now().UTC()
	pdfDateStr := formatPDFDate(now)

	// Factur-X / ZUGFeRD configuration
	fxDocFileName := "factur-x.xml"
	if strings.Contains(profile, "zugferd") {
		fxDocFileName = "zugferd-invoice.xml"
	}
	if opts.XMLFilename != "" {
		fxDocFileName = strings.TrimSpace(opts.XMLFilename)
	}

	fxDocType := "INVOICE"
	if opts.DocumentType != "" {
		fxDocType = strings.TrimSpace(opts.DocumentType)
	}

	fxVersion := "1.0"
	if opts.Version != "" {
		fxVersion = strings.TrimSpace(opts.Version)
	}

	fxConformanceLevel := "EN 16931"
	if opts.InvoiceProfile != "" {
		switch strings.ToUpper(strings.TrimSpace(opts.InvoiceProfile)) {
		case "MINIMUM":
			fxConformanceLevel = "MINIMUM"
		case "BASIC WL", "BASICWL", "BASIC-WL":
			fxConformanceLevel = "BASIC WL"
		case "BASIC":
			fxConformanceLevel = "BASIC"
		case "EN 16931", "EN16931", "COMFORT":
			fxConformanceLevel = "EN 16931"
		case "EXTENDED":
			fxConformanceLevel = "EXTENDED"
		default:
			fxConformanceLevel = strings.TrimSpace(opts.InvoiceProfile)
		}
	}

	// 1. Embed XML payload for Factur-X / ZUGFeRD or PDF/A-3
	if isFacturX || (hasPDFA && part == 3 && strings.TrimSpace(opts.InvoiceXML) != "") {
		xmlBytes, err := decodeInvoiceXML(opts.InvoiceXML)
		if err != nil {
			return nil, fmt.Errorf("compliance decode invoice xml: %w", err)
		}
		if v2 {
			if err := validateFacturXInvoiceXML(xmlBytes, fxConformanceLevel, opts.ValidateXML); err != nil {
				return nil, &renderError{Code: "document_compliance_xml_invalid", Message: err.Error(), Status: 422}
			}
		}

		if err := xRefTable.LocateNameTree("EmbeddedFiles", true); err != nil {
			return nil, fmt.Errorf("locate EmbeddedFiles: %w", err)
		}

		attDesc := "Factur-X Invoice XML"
		if strings.Contains(profile, "zugferd") {
			attDesc = "ZUGFeRD Invoice XML"
		}

		att := model.Attachment{
			Reader:   bytes.NewReader(xmlBytes),
			ID:       fxDocFileName,
			FileName: fxDocFileName,
			Desc:     attDesc,
			ModTime:  &now,
		}

		fileSpecDict, err := xRefTable.NewFileSpecDictForAttachment(att)
		if err != nil {
			return nil, fmt.Errorf("create file spec for invoice xml: %w", err)
		}

		// Required for PDF/A-3 and Factur-X: /AFRelationship /Data, /F, /UF, /Desc
		fileSpecDict.InsertName("AFRelationship", "Data")
		fileSpecDict.InsertString("F", fxDocFileName)
		fileSpecDict.InsertString("UF", fxDocFileName)
		fileSpecDict.InsertString("Desc", attDesc)

		// Embed text/xml MIME subtype and /Params (/Size and /ModDate) on the embedded stream
		if efObj, ok := fileSpecDict["EF"]; ok {
			if efDict, err := xRefTable.DereferenceDict(efObj); err == nil && efDict != nil {
				for _, streamKey := range []string{"F", "UF"} {
					if sObj, ok := efDict[streamKey]; ok {
						if sDict, _, err := xRefTable.DereferenceStreamDict(sObj); err == nil && sDict != nil {
							sDict.InsertName("Subtype", "text/xml")
							if v2 {
								sDict.Insert("Params", types.Dict{
									"Size":    types.Integer(len(xmlBytes)),
									"ModDate": types.StringLiteral(pdfDateStr),
								})
							}
						}
					}
				}
			}
		}

		ir, err := xRefTable.IndRefForNewObject(fileSpecDict)
		if err != nil {
			return nil, fmt.Errorf("file spec ind ref: %w", err)
		}

		m := model.NameMap{att.ID: []types.Dict{fileSpecDict}}
		if err := xRefTable.Names["EmbeddedFiles"].Add(xRefTable, att.ID, *ir, m, []string{"F", "UF"}); err != nil {
			return nil, fmt.Errorf("add to EmbeddedFiles: %w", err)
		}

		// Insert into Document Catalog's /AF (Associated Files) array
		if afObj, ok := ctx.RootDict["AF"]; ok {
			if afArray, err := xRefTable.DereferenceArray(afObj); err == nil && afArray != nil {
				afArray = append(afArray, *ir)
				ctx.RootDict.Insert("AF", afArray)
			} else {
				ctx.RootDict.Insert("AF", types.Array{*ir})
			}
		} else {
			ctx.RootDict.Insert("AF", types.Array{*ir})
		}
	}

	// 2. OutputIntents dictionary with real 3-channel sRGB IEC61966-2.1 ICC profile stream
	outputIntentDict := types.Dict{
		"Type":                      types.Name("OutputIntent"),
		"S":                         types.Name(outputIntentS),
		"OutputCondition":           types.StringLiteral("sRGB IEC61966-2.1"),
		"OutputConditionIdentifier": types.StringLiteral("sRGB IEC61966-2.1"),
		"Info":                      types.StringLiteral("sRGB IEC61966-2.1"),
		"RegistryName":              types.StringLiteral("http://www.color.org"),
	}
	if v2 {
		iccBytes := buildMinimalSRGBICCProfile()
		iccStream, err := xRefTable.NewStreamDictForBuf(iccBytes)
		if err != nil {
			return nil, fmt.Errorf("icc profile stream dict: %w", err)
		}
		iccStream.InsertInt("N", 3)
		iccStream.InsertName("Alternate", "DeviceRGB")
		if err := iccStream.Encode(); err != nil {
			return nil, fmt.Errorf("icc profile encode: %w", err)
		}
		iccRef, err := xRefTable.IndRefForNewObject(*iccStream)
		if err != nil {
			return nil, fmt.Errorf("icc profile ind ref: %w", err)
		}
		outputIntentDict.Insert("DestOutputProfile", *iccRef)
	}
	oiRef, err := xRefTable.IndRefForNewObject(outputIntentDict)
	if err != nil {
		return nil, fmt.Errorf("output intent ind ref: %w", err)
	}
	ctx.RootDict.Insert("OutputIntents", types.Array{*oiRef})

	// 3. Synchronized XMP Metadata packet & PDF /Info dictionary & Trailer /ID
	docTitle := strings.TrimSpace(opts.Title)
	if docTitle == "" {
		docTitle = "RenderPDF Compliant Document"
	}
	docLang := strings.TrimSpace(opts.Language)
	if docLang == "" {
		docLang = "en-US"
	}

	xmpContent := buildXMPMetadataWithOptions(part, conformance, hasPDFA, hasPDFUA, isFacturX, docTitle, fxDocFileName, fxDocType, fxVersion, fxConformanceLevel, now, v2)
	sd, err := xRefTable.NewStreamDictForBuf([]byte(xmpContent))
	if err != nil {
		return nil, fmt.Errorf("xmp stream dict: %w", err)
	}
	sd.InsertName("Type", "Metadata")
	sd.InsertName("Subtype", "XML")
	if err := sd.Encode(); err != nil {
		return nil, fmt.Errorf("xmp encode: %w", err)
	}

	metaRef, err := xRefTable.IndRefForNewObject(*sd)
	if err != nil {
		return nil, fmt.Errorf("xmp metadata ind ref: %w", err)
	}
	ctx.RootDict.Insert("Metadata", *metaRef)

	if v2 {
		// Synchronize /Info dictionary with XMP metadata (ISO 19005-1 clause 6.7.3 & ISO 14289-1 clause 7.1)
		infoDict := types.Dict{
			"Title":        types.StringLiteral(docTitle),
			"Author":       types.StringLiteral("RenderPDF"),
			"Subject":      types.StringLiteral(docTitle),
			"Creator":      types.StringLiteral("RenderPDF"),
			"Producer":     types.StringLiteral("RenderPDF Compliance Engine"),
			"CreationDate": types.StringLiteral(pdfDateStr),
			"ModDate":      types.StringLiteral(pdfDateStr),
		}
		infoRef, err := xRefTable.IndRefForNewObject(infoDict)
		if err != nil {
			return nil, fmt.Errorf("info dict ind ref: %w", err)
		}
		xRefTable.Info = infoRef
		xRefTable.Title = docTitle
		xRefTable.Author = "RenderPDF"
		xRefTable.Subject = docTitle
		xRefTable.Creator = "RenderPDF"
		xRefTable.Producer = "RenderPDF Compliance Engine"
		xRefTable.CreationDate = pdfDateStr
		xRefTable.ModDate = pdfDateStr

		// Ensure trailer /ID is populated
		digest := sha256.Sum256(append(pdfBytes, []byte(xmpContent)...))
		idHex := strings.ToUpper(hex.EncodeToString(digest[:16]))
		xRefTable.ID = types.Array{types.HexLiteral(idHex), types.HexLiteral(idHex)}

		// 4. Tagged PDF & PDF/UA-1 Catalog properties (/MarkInfo, /Lang, /ViewerPreferences, /StructTreeRoot)
		ctx.RootDict.Insert("MarkInfo", types.Dict{"Marked": types.Boolean(true)})
		ctx.RootDict.Insert("Lang", types.StringLiteral(docLang))
		ctx.RootDict.Insert("ViewerPreferences", types.Dict{"DisplayDocTitle": types.Boolean(true)})
		if _, hasStruct := ctx.RootDict["StructTreeRoot"]; !hasStruct {
			structRootDict := types.Dict{
				"Type": types.Name("StructTreeRoot"),
			}
			structRootRef, err := xRefTable.IndRefForNewObject(structRootDict)
			if err != nil {
				return nil, fmt.Errorf("struct tree root ind ref: %w", err)
			}
			docElemDict := types.Dict{
				"Type":  types.Name("StructElem"),
				"S":     types.Name("Document"),
				"Title": types.StringLiteral(docTitle),
				"Lang":  types.StringLiteral(docLang),
				"P":     *structRootRef,
			}
			docElemRef, err := xRefTable.IndRefForNewObject(docElemDict)
			if err != nil {
				return nil, fmt.Errorf("struct elem ind ref: %w", err)
			}
			structRootDict.Insert("K", types.Array{*docElemRef})
			ctx.RootDict.Insert("StructTreeRoot", *structRootRef)
		}
	}

	// 5. Document version
	ctx.HeaderVersion = &headerVersion

	var out bytes.Buffer
	if err := api.Write(ctx, &out, conf); err != nil {
		return nil, fmt.Errorf("write compliant pdf: %w", err)
	}

	res := out.Bytes()
	if hasPDFA && part == 1 && bytes.HasPrefix(res, []byte("%PDF-1.7")) {
		copy(res[0:8], []byte("%PDF-1.4"))
	}

	return res, nil
}
