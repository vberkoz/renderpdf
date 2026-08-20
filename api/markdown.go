package main

import (
	"bytes"
	"fmt"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
)

// documentMarkdown is the deliberately small CommonMark profile used by the
// document source contract. Raw HTML is not enabled, so Markdown cannot bypass
// the document HTML safety checks when conversion is wired into rendering.
var documentMarkdown = goldmark.New(
	goldmark.WithExtensions(
		extension.Table,
		extension.Strikethrough,
		extension.TaskList,
	),
)

// renderMarkdownToHTML converts the validated Markdown source into an HTML
// fragment. The document renderer will run this fragment through its existing
// HTML safety validation before it is placed in the controlled document shell.
func renderMarkdownToHTML(markdown string) (string, error) {
	var output bytes.Buffer
	if err := documentMarkdown.Convert([]byte(markdown), &output); err != nil {
		return "", fmt.Errorf("convert Markdown: %w", err)
	}
	return output.String(), nil
}
