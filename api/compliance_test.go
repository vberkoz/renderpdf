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
