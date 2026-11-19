package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

// mergePDFStreams combines multiple PDF byte slices into a single PDF document.
// It also applies optional page numbering or password security to the merged result.
func mergePDFStreams(pdfSlices [][]byte, options documentRenderOptions) ([]byte, int, error) {
	if len(pdfSlices) < 2 {
		return nil, 0, errors.New("at least 2 PDFs are required to merge")
	}
	readers := make([]io.ReadSeeker, len(pdfSlices))
	for i, b := range pdfSlices {
		if len(b) < 5 || !bytes.HasPrefix(b, []byte("%PDF-")) {
			return nil, 0, fmt.Errorf("item %d is not a valid PDF", i+1)
		}
		readers[i] = bytes.NewReader(b)
	}

	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed

	var buf bytes.Buffer
	if err := api.MergeRaw(readers, &buf, false, conf); err != nil {
		return nil, 0, fmt.Errorf("merge pdfs: %w", err)
	}

	mergedBytes := buf.Bytes()
	var err error
	if options.PageNumbers != nil {
		mergedBytes, err = applyPDFPageNumbers(mergedBytes, options)
		if err != nil {
			return nil, 0, fmt.Errorf("apply page numbers: %w", err)
		}
	}

	if options.Watermark != nil {
		mergedBytes, err = applyPDFWatermark(mergedBytes, options)
		if err != nil {
			return nil, 0, fmt.Errorf("apply watermark: %w", err)
		}
	}

	if options.Compliance != nil {
		mergedBytes, err = applyPDFCompliance(mergedBytes, options)
		if err != nil {
			return nil, 0, fmt.Errorf("apply compliance: %w", err)
		}
	}

	pageCount, err := api.PageCount(bytes.NewReader(mergedBytes), conf)
	if err != nil {
		pageCount = 0
	}

	if options.Password != "" || options.OwnerPassword != "" {
		mergedBytes, err = applyPDFSecurity(mergedBytes, options)
		if err != nil {
			return nil, 0, fmt.Errorf("apply security: %w", err)
		}
	}

	return mergedBytes, pageCount, nil
}
