package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	stdhtml "html"
	"strconv"
	"strings"
	"time"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

// complianceOptions configures archival (PDF/A) and European e-invoicing (Factur-X / ZUGFeRD) compliance.
type complianceOptions struct {
	Profile        string `json:"profile"`                  // "pdfa-1b", "pdfa-2b", "pdfa-3b", "factur-x", "zugferd"
	InvoiceXML     string `json:"invoiceXml,omitempty"`     // Raw XML string or base64-encoded XML
	InvoiceProfile string `json:"invoiceProfile,omitempty"` // "MINIMUM", "BASIC WL", "BASIC", "EN 16931", "EXTENDED" (default: "EN 16931")
	XMLFilename    string `json:"xmlFilename,omitempty"`    // e.g. "factur-x.xml" (default) or "zugferd-invoice.xml"
	DocumentType   string `json:"documentType,omitempty"`   // default "INVOICE"
	Version        string `json:"version,omitempty"`        // default "1.0"
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

// buildXMPMetadata constructs a standardized XMP metadata stream for PDF/A and Factur-X / ZUGFeRD.
func buildXMPMetadata(part int, conformance string, isFacturX bool, fxDocFileName, fxDocType, fxVersion, fxConformanceLevel string) string {
	now := time.Now().UTC().Format(time.RFC3339)
	var sb strings.Builder

	sb.WriteString(`<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>` + strconv.Itoa(part) + `</pdfaid:part>
      <pdfaid:conformance>` + stdhtml.EscapeString(conformance) + `</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>RenderPDF Compliance Engine</pdf:Producer>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>RenderPDF</xmp:CreatorTool>
      <xmp:CreateDate>` + now + `</xmp:CreateDate>
      <xmp:ModifyDate>` + now + `</xmp:ModifyDate>
    </rdf:Description>`)

	if isFacturX {
		sb.WriteString(`
    <rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
      <pdfaExtension:schemas>
        <rdf:Bag>
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
          </rdf:li>
        </rdf:Bag>
      </pdfaExtension:schemas>
    </rdf:Description>
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

// applyPDFCompliance converts a rendered PDF into an archival PDF/A-1b, PDF/A-2b,
// PDF/A-3b, or European e-invoicing Factur-X / ZUGFeRD compliant hybrid document.
func applyPDFCompliance(pdfBytes []byte, options documentRenderOptions) ([]byte, error) {
	if options.Compliance == nil {
		return pdfBytes, nil
	}

	opts := options.Compliance
	profile := strings.ToLower(strings.TrimSpace(opts.Profile))
	if profile == "" {
		return pdfBytes, nil
	}

	part := 3
	conformance := "B"
	outputIntentS := "GTS_PDFA3"
	headerVersion := model.V17
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
		outputIntentS = "GTS_PDFA2"
		headerVersion = model.V17
	case "pdfa-3b", "pdfa3b":
		part = 3
		conformance = "B"
		outputIntentS = "GTS_PDFA3"
		headerVersion = model.V17
	case "factur-x", "facturx", "zugferd", "zugferd2":
		part = 3
		conformance = "B"
		outputIntentS = "GTS_PDFA3"
		headerVersion = model.V17
		isFacturX = true
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

	// Embed XML payload for Factur-X / ZUGFeRD or PDF/A-3
	if isFacturX || (part == 3 && strings.TrimSpace(opts.InvoiceXML) != "") {
		xmlBytes, err := decodeInvoiceXML(opts.InvoiceXML)
		if err != nil {
			return nil, fmt.Errorf("compliance decode invoice xml: %w", err)
		}

		if err := xRefTable.LocateNameTree("EmbeddedFiles", true); err != nil {
			return nil, fmt.Errorf("locate EmbeddedFiles: %w", err)
		}

		modTime := time.Now().UTC()
		attDesc := "Factur-X Invoice XML"
		if strings.Contains(profile, "zugferd") {
			attDesc = "ZUGFeRD Invoice XML"
		}

		att := model.Attachment{
			Reader:   bytes.NewReader(xmlBytes),
			ID:       fxDocFileName,
			FileName: fxDocFileName,
			Desc:     attDesc,
			ModTime:  &modTime,
		}

		fileSpecDict, err := xRefTable.NewFileSpecDictForAttachment(att)
		if err != nil {
			return nil, fmt.Errorf("create file spec for invoice xml: %w", err)
		}

		// Required for PDF/A-3 and Factur-X: /AFRelationship /Data
		fileSpecDict.InsertName("AFRelationship", "Data")

		// Embed text/xml MIME subtype on the embedded stream
		if efObj, ok := fileSpecDict["EF"]; ok {
			if efDict, err := xRefTable.DereferenceDict(efObj); err == nil && efDict != nil {
				if fObj, ok := efDict["F"]; ok {
					if fStream, _, err := xRefTable.DereferenceStreamDict(fObj); err == nil && fStream != nil {
						fStream.InsertName("Subtype", "text/xml")
					}
				}
				if ufObj, ok := efDict["UF"]; ok {
					if ufStream, _, err := xRefTable.DereferenceStreamDict(ufObj); err == nil && ufStream != nil {
						ufStream.InsertName("Subtype", "text/xml")
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

	// 2. OutputIntents dictionary (sRGB IEC61966-2.1)
	outputIntentDict := types.Dict{
		"Type":                      types.Name("OutputIntent"),
		"S":                         types.Name(outputIntentS),
		"OutputConditionIdentifier": types.StringLiteral("sRGB IEC61966-2.1"),
		"Info":                      types.StringLiteral("sRGB IEC61966-2.1"),
		"RegistryName":              types.StringLiteral("http://www.color.org"),
	}
	oiRef, err := xRefTable.IndRefForNewObject(outputIntentDict)
	if err != nil {
		return nil, fmt.Errorf("output intent ind ref: %w", err)
	}
	ctx.RootDict.Insert("OutputIntents", types.Array{*oiRef})

	// 3. XMP Metadata packet
	xmpContent := buildXMPMetadata(part, conformance, isFacturX, fxDocFileName, fxDocType, fxVersion, fxConformanceLevel)
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

	// 4. Document version
	ctx.HeaderVersion = &headerVersion

	var out bytes.Buffer
	if err := api.Write(ctx, &out, conf); err != nil {
		return nil, fmt.Errorf("write compliant pdf: %w", err)
	}

	res := out.Bytes()
	if part == 1 && bytes.HasPrefix(res, []byte("%PDF-1.7")) {
		copy(res[0:8], []byte("%PDF-1.4"))
	}

	return res, nil
}
