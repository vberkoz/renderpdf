package main

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

func TestComplianceOptionsValidation(t *testing.T) {
	// 1. Valid PDF/A-1b
	validPDFA := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile: "pdfa-1b",
		},
	}
	if err := validateDocumentOptions(&validPDFA); err != nil {
		t.Fatalf("expected valid pdfa-1b, got: %v", err)
	}

	// 2. Valid Factur-X
	validFacturX := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile:        "factur-x",
			InvoiceXML:     "<rsm:CrossIndustryInvoice></rsm:CrossIndustryInvoice>",
			InvoiceProfile: "EN 16931",
			XMLFilename:    "factur-x.xml",
		},
	}
	if err := validateDocumentOptions(&validFacturX); err != nil {
		t.Fatalf("expected valid factur-x, got: %v", err)
	}

	// 3. Valid ZUGFeRD
	validZugferd := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile:        "zugferd",
			InvoiceXML:     "<rsm:CrossIndustryInvoice></rsm:CrossIndustryInvoice>",
			InvoiceProfile: "BASIC",
		},
	}
	if err := validateDocumentOptions(&validZugferd); err != nil {
		t.Fatalf("expected valid zugferd, got: %v", err)
	}

	// 4. Missing profile
	emptyProfile := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile: "",
		},
	}
	if err := validateDocumentOptions(&emptyProfile); err == nil || !strings.Contains(err.Error(), "options.compliance.profile is required") {
		t.Fatalf("expected profile required error, got: %v", err)
	}

	// 5. Invalid profile
	invalidProfile := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile: "invalid-profile",
		},
	}
	if err := validateDocumentOptions(&invalidProfile); err == nil || !strings.Contains(err.Error(), "options.compliance.profile must be one of") {
		t.Fatalf("expected invalid profile error, got: %v", err)
	}

	// 6. Factur-X missing invoiceXml
	missingXML := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile: "factur-x",
		},
	}
	if err := validateDocumentOptions(&missingXML); err == nil || !strings.Contains(err.Error(), "options.compliance.invoiceXml is required") {
		t.Fatalf("expected missing XML error, got: %v", err)
	}

	// 7. Invoice profile invalid
	invalidInvProf := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile:        "factur-x",
			InvoiceXML:     "<invoice/>",
			InvoiceProfile: "SUPER_DELUXE",
		},
	}
	if err := validateDocumentOptions(&invalidInvProf); err == nil || !strings.Contains(err.Error(), "options.compliance.invoiceProfile must be one of") {
		t.Fatalf("expected invalid invoice profile error, got: %v", err)
	}

	// 8. XML filename invalid
	invalidFilename := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile:     "factur-x",
			InvoiceXML:  "<invoice/>",
			XMLFilename: "../../secret.xml",
		},
	}
	if err := validateDocumentOptions(&invalidFilename); err == nil || !strings.Contains(err.Error(), "options.compliance.xmlFilename is invalid") {
		t.Fatalf("expected invalid filename error, got: %v", err)
	}

	// 9. Conflict with encryption (password)
	pwConflict := documentRenderOptions{
		Password: "secretpassword",
		Compliance: &complianceOptions{
			Profile: "pdfa-2b",
		},
	}
	if err := validateDocumentOptions(&pwConflict); err == nil || !strings.Contains(err.Error(), "compliance does not allow password-protected") {
		t.Fatalf("expected encryption conflict error, got: %v", err)
	}

	// 10. Conflict with ownerPassword
	ownerPwConflict := documentRenderOptions{
		OwnerPassword: "ownerpassword",
		Compliance: &complianceOptions{
			Profile: "factur-x",
			InvoiceXML: "<invoice/>",
		},
	}
	if err := validateDocumentOptions(&ownerPwConflict); err == nil || !strings.Contains(err.Error(), "compliance does not allow password-protected") {
		t.Fatalf("expected encryption conflict error, got: %v", err)
	}
}

func TestDecodeInvoiceXML(t *testing.T) {
	// Raw string
	rawXML := "<root><invoice>123</invoice></root>"
	b, err := decodeInvoiceXML(rawXML)
	if err != nil || string(b) != rawXML {
		t.Fatalf("unexpected raw decode: %v, string: %s", err, string(b))
	}

	// Base64 standard encoded
	encoded := base64.StdEncoding.EncodeToString([]byte(rawXML))
	b, err = decodeInvoiceXML(encoded)
	if err != nil || string(b) != rawXML {
		t.Fatalf("unexpected b64 decode: %v, string: %s", err, string(b))
	}

	// Base64 URL encoded
	urlEncoded := base64.URLEncoding.EncodeToString([]byte(rawXML))
	b, err = decodeInvoiceXML(urlEncoded)
	if err != nil || string(b) != rawXML {
		t.Fatalf("unexpected url b64 decode: %v, string: %s", err, string(b))
	}

	// Empty string
	_, err = decodeInvoiceXML("   ")
	if err == nil {
		t.Fatalf("expected error on empty XML")
	}
}

func TestApplyPDFCompliancePDFA1b(t *testing.T) {
	orig := []byte(minimalValidPDF)
	opts := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile: "pdfa-1b",
		},
	}

	out, err := applyPDFCompliance(orig, opts)
	if err != nil {
		t.Fatalf("applyPDFCompliance pdfa-1b failed: %v", err)
	}

	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	ctx, err := api.ReadValidateAndOptimize(bytes.NewReader(out), conf)
	if err != nil {
		t.Fatalf("read compliant pdf failed: %v", err)
	}

	// Check header version is 1.4 for PDF/A-1b
	if ctx.HeaderVersion == nil || *ctx.HeaderVersion != model.V14 {
		t.Fatalf("expected HeaderVersion 1.4, got: %v", ctx.HeaderVersion)
	}

	// Check OutputIntents
	oiObj, ok := ctx.RootDict["OutputIntents"]
	if !ok {
		t.Fatalf("expected /OutputIntents in Catalog")
	}
	oiArray, err := ctx.DereferenceArray(oiObj)
	if err != nil || len(oiArray) == 0 {
		t.Fatalf("expected non-empty OutputIntents array: %v", err)
	}
	oiDict, err := ctx.DereferenceDict(oiArray[0])
	if err != nil || oiDict == nil {
		t.Fatalf("expected OutputIntent dict: %v", err)
	}
	sVal := oiDict["S"]
	if sName, ok := sVal.(types.Name); !ok || sName.Value() != "GTS_PDFA1" {
		t.Fatalf("expected OutputIntent S GTS_PDFA1, got: %v", sVal)
	}

	// Check Metadata XMP
	metaObj, ok := ctx.RootDict["Metadata"]
	if !ok {
		t.Fatalf("expected /Metadata in Catalog")
	}
	metaStream, _, err := ctx.DereferenceStreamDict(metaObj)
	if err != nil || metaStream == nil {
		t.Fatalf("expected Metadata stream: %v", err)
	}
	if err := metaStream.Decode(); err != nil {
		t.Fatalf("decode metadata failed: %v", err)
	}
	metaContent := string(metaStream.Content)
	if !strings.Contains(metaContent, "<pdfaid:part>1</pdfaid:part>") {
		t.Fatalf("expected pdfaid:part 1, got: %s", metaContent)
	}
	if !strings.Contains(metaContent, "<pdfaid:conformance>B</pdfaid:conformance>") {
		t.Fatalf("expected pdfaid:conformance B, got: %s", metaContent)
	}
}

func TestApplyPDFCompliancePDFA2bAnd3b(t *testing.T) {
	orig := []byte(minimalValidPDF)

	// PDF/A-2b
	out2, err := applyPDFCompliance(orig, documentRenderOptions{
		Compliance: &complianceOptions{Profile: "pdfa-2b"},
	})
	if err != nil {
		t.Fatalf("pdfa-2b failed: %v", err)
	}
	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	ctx2, err := api.ReadValidateAndOptimize(bytes.NewReader(out2), conf)
	if err != nil {
		t.Fatalf("read pdfa-2b failed: %v", err)
	}
	if ctx2.HeaderVersion == nil || *ctx2.HeaderVersion != model.V17 {
		t.Fatalf("expected HeaderVersion 1.7, got: %v", ctx2.HeaderVersion)
	}

	// PDF/A-3b
	out3, err := applyPDFCompliance(orig, documentRenderOptions{
		Compliance: &complianceOptions{Profile: "pdfa-3b"},
	})
	if err != nil {
		t.Fatalf("pdfa-3b failed: %v", err)
	}
	ctx3, err := api.ReadValidateAndOptimize(bytes.NewReader(out3), conf)
	if err != nil {
		t.Fatalf("read pdfa-3b failed: %v", err)
	}
	if ctx3.HeaderVersion == nil || *ctx3.HeaderVersion != model.V17 {
		t.Fatalf("expected HeaderVersion 1.7, got: %v", ctx3.HeaderVersion)
	}
}

func TestApplyPDFComplianceFacturXAndZUGFeRD(t *testing.T) {
	orig := []byte(minimalValidPDF)
	xmlInvoice := `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100#">
    <rsm:ExchangedDocument>
        <ram:ID>INV-2026-001</ram:ID>
    </rsm:ExchangedDocument>
</rsm:CrossIndustryInvoice>`

	// Factur-X with EN 16931 profile
	opts := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile:        "factur-x",
			InvoiceXML:     xmlInvoice,
			InvoiceProfile: "EN 16931",
		},
	}

	out, err := applyPDFCompliance(orig, opts)
	if err != nil {
		t.Fatalf("applyPDFCompliance factur-x failed: %v", err)
	}

	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed

	// 1. Check attachment in EmbeddedFiles
	atts, err := api.Attachments(bytes.NewReader(out), conf)
	if err != nil {
		t.Fatalf("Attachments failed: %v", err)
	}
	if len(atts) != 1 {
		t.Fatalf("expected 1 attachment, got %d", len(atts))
	}
	if atts[0].FileName != "factur-x.xml" {
		t.Fatalf("expected attachment name factur-x.xml, got %s", atts[0].FileName)
	}

	// 2. Check Catalog dictionary /AF array
	ctx, err := api.ReadValidateAndOptimize(bytes.NewReader(out), conf)
	if err != nil {
		t.Fatalf("ReadValidateAndOptimize failed: %v", err)
	}
	afObj, ok := ctx.RootDict["AF"]
	if !ok {
		t.Fatalf("expected /AF in Catalog")
	}
	afArray, err := ctx.DereferenceArray(afObj)
	if err != nil || len(afArray) != 1 {
		t.Fatalf("expected 1 entry in /AF array, got: %v", afArray)
	}
	fileSpecDict, err := ctx.DereferenceDict(afArray[0])
	if err != nil || fileSpecDict == nil {
		t.Fatalf("expected FileSpec dictionary from /AF, got: %v", err)
	}
	if afRel, ok := fileSpecDict["AFRelationship"]; !ok || afRel.(types.Name).Value() != "Data" {
		t.Fatalf("expected /AFRelationship /Data, got: %v", afRel)
	}

	// 3. Check XMP metadata contains Factur-X extension schema and properties
	metaObj, ok := ctx.RootDict["Metadata"]
	if !ok {
		t.Fatalf("expected /Metadata in Catalog")
	}
	metaStream, _, err := ctx.DereferenceStreamDict(metaObj)
	if err != nil || metaStream == nil {
		t.Fatalf("expected valid Metadata stream: %v", err)
	}
	if err := metaStream.Decode(); err != nil {
		t.Fatalf("failed to decode metadata stream: %v", err)
	}
	xmp := string(metaStream.Content)
	if !strings.Contains(xmp, "Factur-X PDFA Extension Schema") {
		t.Fatalf("expected Factur-X schema in XMP, got: %s", xmp)
	}
	if !strings.Contains(xmp, "<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>") {
		t.Fatalf("expected fx:DocumentFileName, got: %s", xmp)
	}
	if !strings.Contains(xmp, "<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>") {
		t.Fatalf("expected fx:ConformanceLevel EN 16931, got: %s", xmp)
	}
	if !strings.Contains(xmp, "<pdfaid:part>3</pdfaid:part>") {
		t.Fatalf("expected pdfaid:part 3, got: %s", xmp)
	}

	// ZUGFeRD with custom filename and EXTENDED profile
	zugferdOpts := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile:        "zugferd",
			InvoiceXML:     base64.StdEncoding.EncodeToString([]byte(xmlInvoice)),
			InvoiceProfile: "EXTENDED",
			XMLFilename:    "zugferd-invoice.xml",
		},
	}
	outZugferd, err := applyPDFCompliance(orig, zugferdOpts)
	if err != nil {
		t.Fatalf("applyPDFCompliance zugferd failed: %v", err)
	}
	attsZ, err := api.Attachments(bytes.NewReader(outZugferd), conf)
	if err != nil || len(attsZ) != 1 || attsZ[0].FileName != "zugferd-invoice.xml" {
		t.Fatalf("expected zugferd-invoice.xml attachment, got: %v", attsZ)
	}
}

func TestMergePDFWithCompliance(t *testing.T) {
	pdf1 := []byte(minimalValidPDF)
	pdf2 := []byte(minimalValidPDF)

	opts := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile:    "factur-x",
			InvoiceXML: "<invoice>123</invoice>",
		},
	}

	merged, pageCount, err := mergePDFStreams([][]byte{pdf1, pdf2}, opts)
	if err != nil {
		t.Fatalf("mergePDFStreams with compliance failed: %v", err)
	}
	if pageCount != 2 {
		t.Fatalf("expected 2 pages, got %d", pageCount)
	}

	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	atts, err := api.Attachments(bytes.NewReader(merged), conf)
	if err != nil || len(atts) != 1 || atts[0].FileName != "factur-x.xml" {
		t.Fatalf("expected merged PDF to contain factur-x.xml attachment, got: %v", atts)
	}
}

func TestVeraPDFStructuralClausesAndICCProfile(t *testing.T) {
	orig := []byte(minimalValidPDF)
	trueVal := true

	profiles := []struct {
		name     string
		opts     complianceOptions
		wantPart string
		wantUA   bool
	}{
		{
			name:     "pdfa-1b",
			opts:     complianceOptions{Profile: "pdfa-1b", Title: "Archival Part 1", Language: "en-US"},
			wantPart: "1",
			wantUA:   false,
		},
		{
			name:     "pdfa-2b",
			opts:     complianceOptions{Profile: "pdfa-2b", Title: "Archival Part 2", Language: "de-DE"},
			wantPart: "2",
			wantUA:   false,
		},
		{
			name:     "pdfa-3b+pdfua",
			opts:     complianceOptions{Profile: "pdfa-3b", PDFUA: &trueVal, Title: "Accessible Archival", Language: "fr-FR"},
			wantPart: "3",
			wantUA:   true,
		},
		{
			name:     "pdfua-1-standalone",
			opts:     complianceOptions{Profile: "pdfua-1", Title: "Universal Accessibility", Language: "en-GB"},
			wantPart: "",
			wantUA:   true,
		},
	}

	for _, tc := range profiles {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateDocumentOptions(&documentRenderOptions{Compliance: &tc.opts}); err != nil {
				t.Fatalf("validateDocumentOptions(%s) failed: %v", tc.name, err)
			}
			out, err := applyPDFCompliance(orig, documentRenderOptions{Compliance: &tc.opts})
			if err != nil {
				t.Fatalf("applyPDFCompliance(%s) failed: %v", tc.name, err)
			}

			conf := model.NewDefaultConfiguration()
			conf.ValidationMode = model.ValidationRelaxed
			ctx, err := api.ReadValidateAndOptimize(bytes.NewReader(out), conf)
			if err != nil {
				t.Fatalf("ReadValidateAndOptimize(%s) failed: %v", tc.name, err)
			}

			// 1. /OutputIntents must have /S /GTS_PDFA1 and /DestOutputProfile with /N 3 and valid "acsp" ICC profile
			oiArray, err := ctx.DereferenceArray(ctx.RootDict["OutputIntents"])
			if err != nil || len(oiArray) != 1 {
				t.Fatalf("expected 1 OutputIntent, got: %v (err=%v)", oiArray, err)
			}
			oiDict, err := ctx.DereferenceDict(oiArray[0])
			if err != nil || oiDict == nil {
				t.Fatalf("expected OutputIntent dict: %v", err)
			}
			if sName, ok := oiDict["S"].(types.Name); !ok || sName.Value() != "GTS_PDFA1" {
				t.Fatalf("expected /S /GTS_PDFA1 for ISO 19005 compliance, got: %v", oiDict["S"])
			}
			destObj, ok := oiDict["DestOutputProfile"]
			if !ok {
				t.Fatalf("expected /DestOutputProfile in OutputIntent")
			}
			iccStream, _, err := ctx.DereferenceStreamDict(destObj)
			if err != nil || iccStream == nil {
				t.Fatalf("expected DestOutputProfile stream dict: %v", err)
			}
			if nVal := iccStream.IntEntry("N"); nVal == nil || *nVal != 3 {
				t.Fatalf("expected /N 3 on sRGB DestOutputProfile stream, got: %v", nVal)
			}
			if err := iccStream.Decode(); err != nil {
				t.Fatalf("decode ICC stream failed: %v", err)
			}
			if len(iccStream.Content) < 132 || string(iccStream.Content[36:40]) != "acsp" || string(iccStream.Content[16:20]) != "RGB " {
				t.Fatalf("invalid ICC profile header in DestOutputProfile: len=%d", len(iccStream.Content))
			}

			// 2. Tagged PDF / PDF/UA-1 structural requirements
			markInfo, err := ctx.DereferenceDict(ctx.RootDict["MarkInfo"])
			if err != nil || markInfo == nil || markInfo["Marked"] != types.Boolean(true) {
				t.Fatalf("expected /MarkInfo << /Marked true >>, got: %v", markInfo)
			}
			if langLit, ok := ctx.RootDict["Lang"].(types.StringLiteral); !ok || langLit.Value() != tc.opts.Language {
				t.Fatalf("expected /Lang %q, got: %v", tc.opts.Language, ctx.RootDict["Lang"])
			}
			vpDict, err := ctx.DereferenceDict(ctx.RootDict["ViewerPreferences"])
			if err != nil || vpDict == nil || vpDict["DisplayDocTitle"] != types.Boolean(true) {
				t.Fatalf("expected /ViewerPreferences << /DisplayDocTitle true >>, got: %v", vpDict)
			}
			structRoot, err := ctx.DereferenceDict(ctx.RootDict["StructTreeRoot"])
			if err != nil || structRoot == nil {
				t.Fatalf("expected /StructTreeRoot in Catalog, got: %v", err)
			}

			// 3. XMP metadata synchronization (dc:title, pdfaid, pdfuaid) & trailer /ID
			if len(ctx.XRefTable.ID) != 2 {
				t.Fatalf("expected 2-element trailer /ID, got: %v", ctx.XRefTable.ID)
			}
			metaStream, _, err := ctx.DereferenceStreamDict(ctx.RootDict["Metadata"])
			if err != nil || metaStream == nil {
				t.Fatalf("expected Metadata stream: %v", err)
			}
			if err := metaStream.Decode(); err != nil {
				t.Fatalf("decode Metadata stream: %v", err)
			}
			xmp := string(metaStream.Content)
			if !strings.Contains(xmp, "<dc:title>") || !strings.Contains(xmp, tc.opts.Title) {
				t.Fatalf("expected dc:title %q in XMP:\n%s", tc.opts.Title, xmp)
			}
			if tc.wantPart != "" && !strings.Contains(xmp, "<pdfaid:part>"+tc.wantPart+"</pdfaid:part>") {
				t.Fatalf("expected pdfaid:part %s in XMP:\n%s", tc.wantPart, xmp)
			}
			if tc.wantUA && !strings.Contains(xmp, "<pdfuaid:part>1</pdfuaid:part>") {
				t.Fatalf("expected pdfuaid:part 1 in XMP:\n%s", xmp)
			}
		})
	}
}

func TestKoSITEN16931CIIValidation(t *testing.T) {
	validCII := `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>INV-2026-900</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">20261120</udt:DateTimeString>
    </ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement/>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement/>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`

	if err := validateKoSITEN16931XML([]byte(validCII), "EN 16931"); err != nil {
		t.Fatalf("expected valid KoSIT EN 16931 CII XML to pass, got: %v", err)
	}

	validOpts := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile:        "factur-x",
			InvoiceProfile: "EN 16931",
			InvoiceXML:     validCII,
		},
	}
	if err := validateDocumentOptions(&validOpts); err != nil {
		t.Fatalf("validateDocumentOptions failed for valid CII XML: %v", err)
	}

	// Verify Factur-X embedded stream includes /Params << /Size ... /ModDate ... >>
	out, err := applyPDFCompliance([]byte(minimalValidPDF), validOpts)
	if err != nil {
		t.Fatalf("applyPDFCompliance failed for valid CII XML: %v", err)
	}
	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	ctx, err := api.ReadValidateAndOptimize(bytes.NewReader(out), conf)
	if err != nil {
		t.Fatalf("ReadValidateAndOptimize failed: %v", err)
	}
	afArr, _ := ctx.DereferenceArray(ctx.RootDict["AF"])
	fsDict, _ := ctx.DereferenceDict(afArr[0])
	efDict, _ := ctx.DereferenceDict(fsDict["EF"])
	fStream, _, _ := ctx.DereferenceStreamDict(efDict["F"])
	paramsDict, err := ctx.DereferenceDict(fStream.Dict["Params"])
	if err != nil || paramsDict == nil || paramsDict["Size"] == nil || paramsDict["ModDate"] == nil {
		t.Fatalf("expected /Params with /Size and /ModDate on embedded Factur-X stream, got: %v", paramsDict)
	}

	trueVal := true
	invalidCases := []struct {
		name string
		xml  string
	}{
		{
			name: "malformed unclosed tag",
			xml:  `<rsm:CrossIndustryInvoice><rsm:ExchangedDocument></rsm:CrossIndustryInvoice>`,
		},
		{
			name: "missing ExchangedDocumentContext",
			xml: `<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100">
				<rsm:ExchangedDocument><ram:ID>INV-1</ram:ID></rsm:ExchangedDocument>
				<rsm:SupplyChainTradeTransaction/>
			</rsm:CrossIndustryInvoice>`,
		},
		{
			name: "missing ExchangedDocument/ID",
			xml: `<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100">
				<rsm:ExchangedDocumentContext/>
				<rsm:ExchangedDocument><ram:TypeCode>380</ram:TypeCode></rsm:ExchangedDocument>
				<rsm:SupplyChainTradeTransaction/>
			</rsm:CrossIndustryInvoice>`,
		},
		{
			name: "missing SupplyChainTradeTransaction",
			xml: `<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100">
				<rsm:ExchangedDocumentContext/>
				<rsm:ExchangedDocument><ram:ID>INV-1</ram:ID></rsm:ExchangedDocument>
			</rsm:CrossIndustryInvoice>`,
		},
	}

	for _, tc := range invalidCases {
		t.Run(tc.name, func(t *testing.T) {
			opts := documentRenderOptions{
				Compliance: &complianceOptions{
					Profile:     "factur-x",
					InvoiceXML:  tc.xml,
					ValidateXML: &trueVal,
				},
			}
			err := validateDocumentOptions(&opts)
			if err == nil {
				t.Fatalf("expected %s to fail validation", tc.name)
			}
			rErr, ok := err.(*renderError)
			if !ok || rErr.Status != 422 || rErr.Code != "document_compliance_xml_invalid" {
				t.Fatalf("expected 422 document_compliance_xml_invalid for %s, got: %#v", tc.name, err)
			}
		})
	}

	// Invalid BCP-47 language tag
	badLangOpts := documentRenderOptions{
		Compliance: &complianceOptions{
			Profile:  "pdfa-3b",
			Language: "not_a_valid_lang!!!",
		},
	}
	if err := validateDocumentOptions(&badLangOpts); err == nil {
		t.Fatalf("expected invalid language tag to be rejected")
	}
}

func TestComplianceEngineV2RollbackFlag(t *testing.T) {
	t.Setenv("COMPLIANCE_ENGINE_V2", "false")

	out, err := applyPDFCompliance([]byte(minimalValidPDF), documentRenderOptions{
		Compliance: &complianceOptions{Profile: "pdfa-3b"},
	})
	if err != nil {
		t.Fatalf("applyPDFCompliance with COMPLIANCE_ENGINE_V2=false failed: %v", err)
	}
	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	ctx, err := api.ReadValidateAndOptimize(bytes.NewReader(out), conf)
	if err != nil {
		t.Fatalf("ReadValidateAndOptimize failed: %v", err)
	}
	oiArray, _ := ctx.DereferenceArray(ctx.RootDict["OutputIntents"])
	oiDict, _ := ctx.DereferenceDict(oiArray[0])
	if sName, ok := oiDict["S"].(types.Name); !ok || sName.Value() != "GTS_PDFA3" {
		t.Fatalf("expected legacy GTS_PDFA3 when COMPLIANCE_ENGINE_V2=false, got: %v", oiDict["S"])
	}
	if _, hasDest := oiDict["DestOutputProfile"]; hasDest {
		t.Fatalf("expected no DestOutputProfile when COMPLIANCE_ENGINE_V2=false")
	}
}

