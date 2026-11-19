package main

import (
	"fmt"
	stdhtml "html"
	"reflect"
	"strings"
)

const (
	maxTemplateBlockDepth     = 5
	maxTemplateEachIterations = 1000
)

type templateNodeKind int

const (
	nodeText templateNodeKind = iota
	nodeVariable
	nodeHelper
	nodeIf
	nodeEach
)

type templateNode struct {
	kind       templateNodeKind
	text       string
	expr       string
	tag        *parsedTemplateTag
	negate     bool
	thenBranch []templateNode
	elseBranch []templateNode
	body       []templateNode
}

type templateAST struct {
	nodes     []templateNode
	hasBlocks bool
}

type templateBuildFrame struct {
	kind       string // "if", "unless", "each"
	expr       string
	negate     bool
	inElse     bool
	thenBranch []templateNode
	elseBranch []templateNode
	body       []templateNode
}

type templateScope struct {
	data   any
	isLoop bool
	index  int
	first  bool
	last   bool
}

func isValidTemplateExpr(expr string) bool {
	if expr == "" {
		return false
	}
	if expr == "." || expr == "this" || expr == "@index" || expr == "@first" || expr == "@last" {
		return true
	}
	rest := expr
	hasUp := false
	for strings.HasPrefix(rest, "../") {
		rest = strings.TrimPrefix(rest, "../")
		hasUp = true
	}
	if rest == ".." {
		return true
	}
	if hasUp {
		if rest == "" || rest == "." || rest == "this" || rest == "@index" || rest == "@first" || rest == "@last" {
			return true
		}
	}
	if strings.HasPrefix(rest, "this.") {
		rest = strings.TrimPrefix(rest, "this.")
		if rest == "" {
			return false
		}
	} else if strings.HasPrefix(rest, "./") {
		rest = strings.TrimPrefix(rest, "./")
		if rest == "" {
			return false
		}
	}
	segments := strings.Split(rest, ".")
	for _, seg := range segments {
		if !templatePathSegment(seg) {
			return false
		}
	}
	return true
}

func parseTemplateAST(templateText string) (templateAST, error) {
	matches := templateTagPattern.FindAllStringSubmatchIndex(templateText, -1)
	if strings.Contains(templateText, "{{") || strings.Contains(templateText, "}}") {
		matched := 0
		for _, match := range matches {
			matched += strings.Count(templateText[match[0]:match[1]], "{{")
		}
		if matched != strings.Count(templateText, "{{") || matched != strings.Count(templateText, "}}") {
			return templateAST{}, templateVariableError(invalidTemplateVariableCode, "Template contains an invalid placeholder; use {{path.to.value}}")
		}
	}

	var root []templateNode
	var stack []*templateBuildFrame
	hasBlocks := false

	appendNode := func(node templateNode) {
		if len(stack) == 0 {
			root = append(root, node)
			return
		}
		top := stack[len(stack)-1]
		switch top.kind {
		case "each":
			top.body = append(top.body, node)
		case "if", "unless":
			if top.inElse {
				top.elseBranch = append(top.elseBranch, node)
			} else {
				top.thenBranch = append(top.thenBranch, node)
			}
		}
	}

	lastIndex := 0
	for _, match := range matches {
		if match[0] > lastIndex {
			appendNode(templateNode{kind: nodeText, text: templateText[lastIndex:match[0]]})
		}
		rawInner := templateText[match[2]:match[3]]
		inner := strings.TrimSpace(rawInner)

		switch {
		case inner == "#each" || strings.HasPrefix(inner, "#each ") || strings.HasPrefix(inner, "#each\t"):
			hasBlocks = true
			expr := strings.TrimSpace(inner[len("#each"):])
			if !isValidTemplateExpr(expr) || strings.HasPrefix(expr, "@") {
				return templateAST{}, templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Template contains an invalid #each block expression %q", inner))
			}
			if len(stack)+1 > maxTemplateBlockDepth {
				return templateAST{}, templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Template block nesting exceeds maximum depth of %d", maxTemplateBlockDepth))
			}
			stack = append(stack, &templateBuildFrame{kind: "each", expr: expr})

		case inner == "#if" || strings.HasPrefix(inner, "#if ") || strings.HasPrefix(inner, "#if\t"):
			hasBlocks = true
			expr := strings.TrimSpace(inner[len("#if"):])
			if !isValidTemplateExpr(expr) {
				return templateAST{}, templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Template contains an invalid #if condition %q", inner))
			}
			if len(stack)+1 > maxTemplateBlockDepth {
				return templateAST{}, templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Template block nesting exceeds maximum depth of %d", maxTemplateBlockDepth))
			}
			stack = append(stack, &templateBuildFrame{kind: "if", expr: expr, negate: false})

		case inner == "#unless" || strings.HasPrefix(inner, "#unless ") || strings.HasPrefix(inner, "#unless\t"):
			hasBlocks = true
			expr := strings.TrimSpace(inner[len("#unless"):])
			if !isValidTemplateExpr(expr) {
				return templateAST{}, templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Template contains an invalid #unless condition %q", inner))
			}
			if len(stack)+1 > maxTemplateBlockDepth {
				return templateAST{}, templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Template block nesting exceeds maximum depth of %d", maxTemplateBlockDepth))
			}
			stack = append(stack, &templateBuildFrame{kind: "unless", expr: expr, negate: true})

		case inner == "else":
			if len(stack) == 0 {
				return templateAST{}, templateVariableError(invalidTemplateVariableCode, "Template contains an unexpected {{else}} outside #if/#unless block")
			}
			top := stack[len(stack)-1]
			if (top.kind != "if" && top.kind != "unless") || top.inElse {
				return templateAST{}, templateVariableError(invalidTemplateVariableCode, "Template contains an unexpected {{else}} block")
			}
			top.inElse = true

		case inner == "/each":
			if len(stack) == 0 || stack[len(stack)-1].kind != "each" {
				return templateAST{}, templateVariableError(invalidTemplateVariableCode, "Template contains a mismatched {{/each}} block")
			}
			frame := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			appendNode(templateNode{kind: nodeEach, expr: frame.expr, body: frame.body})

		case inner == "/if":
			if len(stack) == 0 || stack[len(stack)-1].kind != "if" {
				return templateAST{}, templateVariableError(invalidTemplateVariableCode, "Template contains a mismatched {{/if}} block")
			}
			frame := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			appendNode(templateNode{kind: nodeIf, expr: frame.expr, negate: frame.negate, thenBranch: frame.thenBranch, elseBranch: frame.elseBranch})

		case inner == "/unless":
			if len(stack) == 0 || stack[len(stack)-1].kind != "unless" {
				return templateAST{}, templateVariableError(invalidTemplateVariableCode, "Template contains a mismatched {{/unless}} block")
			}
			frame := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			appendNode(templateNode{kind: nodeIf, expr: frame.expr, negate: frame.negate, thenBranch: frame.thenBranch, elseBranch: frame.elseBranch})

		case strings.HasPrefix(inner, "#") || strings.HasPrefix(inner, "/") || strings.HasPrefix(inner, "else ") || strings.HasPrefix(inner, "else\t"):
			return templateAST{}, templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Template contains an unsupported block directive %q", inner))

		default:
			if isValidTemplateExpr(inner) {
				appendNode(templateNode{kind: nodeVariable, expr: inner})
			} else {
				tag, err := parseTemplateTag(rawInner)
				if err != nil {
					return templateAST{}, templateVariableError(invalidTemplateVariableCode, "Template contains an invalid placeholder; use {{path.to.value}}")
				}
				appendNode(templateNode{kind: nodeHelper, tag: tag})
			}
		}

		lastIndex = match[1]
	}

	if len(stack) > 0 {
		top := stack[len(stack)-1]
		return templateAST{}, templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Template has an unclosed {{#%s}} block", top.kind))
	}
	if lastIndex < len(templateText) {
		appendNode(templateNode{kind: nodeText, text: templateText[lastIndex:]})
	}

	return templateAST{nodes: root, hasBlocks: hasBlocks}, nil
}

func validateTemplateVariables(value any) error {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if !templatePathSegment(key) {
				return templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Invalid template variable name %q", key))
			}
			if err := validateTemplateVariables(child); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range typed {
			if err := validateTemplateVariables(child); err != nil {
				return err
			}
		}
	case []map[string]any:
		for _, child := range typed {
			if err := validateTemplateVariables(child); err != nil {
				return err
			}
		}
	}
	return nil
}

func collectFlatExpectedPaths(nodes []templateNode, expected map[string]struct{}) {
	for _, node := range nodes {
		switch node.kind {
		case nodeVariable:
			expected[node.expr] = struct{}{}
		case nodeHelper:
			for _, arg := range node.tag.posArgs {
				if arg.isVar {
					expected[arg.varPath] = struct{}{}
				}
			}
			for _, arg := range node.tag.options {
				if arg.isVar {
					expected[arg.varPath] = struct{}{}
				}
			}
		}
	}
}

func lookupDottedPath(root any, path string) (any, bool) {
	if path == "" {
		return root, true
	}
	cur := root
	for _, seg := range strings.Split(path, ".") {
		switch m := cur.(type) {
		case map[string]any:
			val, ok := m[seg]
			if !ok {
				return nil, false
			}
			cur = val
		case map[string]string:
			val, ok := m[seg]
			if !ok {
				return nil, false
			}
			cur = val
		default:
			return nil, false
		}
	}
	return cur, true
}

func resolveTemplateExpr(scopes []templateScope, expr string) (any, bool) {
	if len(scopes) == 0 {
		return nil, false
	}
	rest := expr
	upCount := 0
	for strings.HasPrefix(rest, "../") {
		rest = strings.TrimPrefix(rest, "../")
		upCount++
	}
	if rest == ".." {
		rest = ""
		upCount++
	}

	if upCount > 0 {
		targetIdx := len(scopes) - 1 - upCount
		if targetIdx < 0 {
			return nil, false
		}
		target := scopes[targetIdx]
		switch rest {
		case "", ".", "this":
			return target.data, true
		case "@index":
			if !target.isLoop {
				return nil, false
			}
			return target.index, true
		case "@first":
			if !target.isLoop {
				return nil, false
			}
			return target.first, true
		case "@last":
			if !target.isLoop {
				return nil, false
			}
			return target.last, true
		}
		if strings.HasPrefix(rest, "this.") {
			return lookupDottedPath(target.data, strings.TrimPrefix(rest, "this."))
		}
		if strings.HasPrefix(rest, "./") {
			return lookupDottedPath(target.data, strings.TrimPrefix(rest, "./"))
		}
		for i := targetIdx; i >= 0; i-- {
			if val, ok := lookupDottedPath(scopes[i].data, rest); ok {
				return val, true
			}
		}
		return nil, false
	}

	top := scopes[len(scopes)-1]
	switch rest {
	case ".", "this":
		return top.data, true
	case "@index":
		for i := len(scopes) - 1; i >= 0; i-- {
			if scopes[i].isLoop {
				return scopes[i].index, true
			}
		}
		return nil, false
	case "@first":
		for i := len(scopes) - 1; i >= 0; i-- {
			if scopes[i].isLoop {
				return scopes[i].first, true
			}
		}
		return nil, false
	case "@last":
		for i := len(scopes) - 1; i >= 0; i-- {
			if scopes[i].isLoop {
				return scopes[i].last, true
			}
		}
		return nil, false
	}

	if strings.HasPrefix(rest, "this.") {
		return lookupDottedPath(top.data, strings.TrimPrefix(rest, "this."))
	}
	if strings.HasPrefix(rest, "./") {
		return lookupDottedPath(top.data, strings.TrimPrefix(rest, "./"))
	}
	for i := len(scopes) - 1; i >= 0; i-- {
		if val, ok := lookupDottedPath(scopes[i].data, rest); ok {
			return val, true
		}
	}
	return nil, false
}

func isTemplateTruthy(val any) bool {
	if val == nil {
		return false
	}
	switch v := val.(type) {
	case bool:
		return v
	case string:
		return v != ""
	case int:
		return v != 0
	case int8:
		return v != 0
	case int16:
		return v != 0
	case int32:
		return v != 0
	case int64:
		return v != 0
	case uint:
		return v != 0
	case uint8:
		return v != 0
	case uint16:
		return v != 0
	case uint32:
		return v != 0
	case uint64:
		return v != 0
	case float32:
		return v != 0
	case float64:
		return v != 0
	}
	rv := reflect.ValueOf(val)
	switch rv.Kind() {
	case reflect.Slice, reflect.Array, reflect.Map:
		return rv.Len() > 0
	default:
		return true
	}
}

func toIterableSlice(val any) ([]any, bool) {
	if val == nil {
		return nil, true
	}
	if typed, ok := val.([]any); ok {
		return typed, true
	}
	rv := reflect.ValueOf(val)
	if rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		return nil, false
	}
	out := make([]any, rv.Len())
	for i := 0; i < rv.Len(); i++ {
		out[i] = rv.Index(i).Interface()
	}
	return out, true
}

func resolveHelperScopeValues(tag *parsedTemplateTag, scopes []templateScope) (map[string]any, error) {
	resolved := make(map[string]any)
	resolveArg := func(arg helperArg) error {
		if !arg.isVar {
			return nil
		}
		if _, exists := resolved[arg.varPath]; exists {
			return nil
		}
		val, ok := resolveTemplateExpr(scopes, arg.varPath)
		if !ok || val == nil {
			return templateVariableError(missingTemplateVariableCode, fmt.Sprintf("Missing required template variable %q", arg.varPath))
		}
		resolved[arg.varPath] = val
		return nil
	}
	for _, arg := range tag.posArgs {
		if err := resolveArg(arg); err != nil {
			return nil, err
		}
	}
	for _, arg := range tag.options {
		if err := resolveArg(arg); err != nil {
			return nil, err
		}
	}
	return resolved, nil
}

func renderTemplateNodes(nodes []templateNode, scopes []templateScope, escapeFn func(any) string, iterCount *int, out *strings.Builder) error {
	for _, node := range nodes {
		switch node.kind {
		case nodeText:
			out.WriteString(node.text)

		case nodeVariable:
			val, ok := resolveTemplateExpr(scopes, node.expr)
			if !ok || val == nil {
				return templateVariableError(missingTemplateVariableCode, fmt.Sprintf("Missing required template variable %q", node.expr))
			}
			out.WriteString(escapeFn(val))

		case nodeHelper:
			helperValues, err := resolveHelperScopeValues(node.tag, scopes)
			if err != nil {
				return err
			}
			svg, err := executeTemplateHelper(node.tag, helperValues)
			if err != nil {
				return templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Template helper error: %v", err))
			}
			out.WriteString(svg)

		case nodeIf:
			val, ok := resolveTemplateExpr(scopes, node.expr)
			cond := ok && isTemplateTruthy(val)
			if node.negate {
				cond = !cond
			}
			branch := node.elseBranch
			if cond {
				branch = node.thenBranch
			}
			if err := renderTemplateNodes(branch, scopes, escapeFn, iterCount, out); err != nil {
				return err
			}

		case nodeEach:
			val, ok := resolveTemplateExpr(scopes, node.expr)
			if !ok || val == nil {
				continue
			}
			items, iterable := toIterableSlice(val)
			if !iterable {
				return templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Template #each variable %q must be an array", node.expr))
			}
			for idx, item := range items {
				*iterCount++
				if *iterCount > maxTemplateEachIterations {
					return templateVariableError(invalidTemplateVariableCode, fmt.Sprintf("Template #each iterations exceeded maximum of %d", maxTemplateEachIterations))
				}
				childScopes := append(scopes, templateScope{
					data:   item,
					isLoop: true,
					index:  idx,
					first:  idx == 0,
					last:   idx == len(items)-1,
				})
				if err := renderTemplateNodes(node.body, childScopes, escapeFn, iterCount, out); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func renderTemplateWithOptions(templateText string, variables map[string]any, allowExtra bool, escapeFn func(any) string) (string, error) {
	ast, err := parseTemplateAST(templateText)
	if err != nil {
		return "", err
	}

	if !ast.hasBlocks && !allowExtra {
		values, err := flattenTemplateVariables(variables, "")
		if err != nil {
			return "", err
		}
		expected := make(map[string]struct{})
		collectFlatExpectedPaths(ast.nodes, expected)
		for path := range expected {
			if _, ok := values[path]; !ok {
				return "", templateVariableError(missingTemplateVariableCode, fmt.Sprintf("Missing required template variable %q", path))
			}
		}
		for path := range values {
			if _, ok := expected[path]; !ok {
				return "", templateVariableError(unknownTemplateVariableCode, fmt.Sprintf("Unknown template variable %q", path))
			}
		}
	} else if err := validateTemplateVariables(variables); err != nil {
		return "", err
	}

	var out strings.Builder
	iterCount := 0
	scopes := []templateScope{{data: variables, isLoop: false}}
	if err := renderTemplateNodes(ast.nodes, scopes, escapeFn, &iterCount, &out); err != nil {
		return "", err
	}
	return out.String(), nil
}

func defaultTemplateEscape(value any) string {
	return stdhtml.EscapeString(fmt.Sprint(value))
}

func mergeTemplateVariableMaps(base, override map[string]any) map[string]any {
	if base == nil && override == nil {
		return nil
	}
	merged := make(map[string]any, len(base)+len(override))
	for k, v := range base {
		merged[k] = cloneTemplateValue(v)
	}
	for k, v := range override {
		if baseMap, ok := merged[k].(map[string]any); ok {
			if overrideMap, ok := v.(map[string]any); ok {
				merged[k] = mergeTemplateVariableMaps(baseMap, overrideMap)
				continue
			}
		}
		merged[k] = cloneTemplateValue(v)
	}
	return merged
}

func cloneTemplateValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for k, v := range typed {
			out[k] = cloneTemplateValue(v)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, v := range typed {
			out[i] = cloneTemplateValue(v)
		}
		return out
	default:
		return value
	}
}
