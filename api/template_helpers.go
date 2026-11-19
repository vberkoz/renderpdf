package main

import (
	"fmt"
	"strconv"
	"strings"
)

type templateTagType int

const (
	tagTypeVariable templateTagType = iota
	tagTypeHelper
)

type helperArg struct {
	isLiteral bool
	isVar     bool
	varPath   string
	strVal    string
	isBool    bool
	boolVal   bool
}

func (a helperArg) resolve(values map[string]any) string {
	if a.isVar {
		if val, ok := values[a.varPath]; ok && val != nil {
			return fmt.Sprint(val)
		}
		return ""
	}
	return a.strVal
}

func (a helperArg) resolveBool(values map[string]any, defaultVal bool) bool {
	if a.isBool {
		return a.boolVal
	}
	s := strings.ToLower(a.resolve(values))
	if s == "false" || s == "0" || s == "no" {
		return false
	}
	if s == "true" || s == "1" || s == "yes" {
		return true
	}
	return defaultVal
}

type parsedTemplateTag struct {
	raw        string
	tagType    templateTagType
	varPath    string
	helperName string
	posArgs    []helperArg
	options    map[string]helperArg
}

func isKnownHelper(name string) bool {
	switch strings.ToLower(name) {
	case "barcode", "qrcode", "qr-code", "qr_code", "qr":
		return true
	default:
		return false
	}
}

func parseHelperArgs(remainder string) ([]helperArg, map[string]helperArg, error) {
	var posArgs []helperArg
	options := make(map[string]helperArg)

	i := 0
	n := len(remainder)

	for i < n {
		for i < n && (remainder[i] == ' ' || remainder[i] == '\t' || remainder[i] == '\r' || remainder[i] == '\n') {
			i++
		}
		if i >= n {
			break
		}

		eqIdx := -1
		for j := i; j < n; j++ {
			c := remainder[j]
			if c == ' ' || c == '\t' || c == '\r' || c == '\n' {
				break
			}
			if c == '=' {
				eqIdx = j
				break
			}
		}

		var optKey string
		if eqIdx > i {
			candidateKey := remainder[i:eqIdx]
			if templatePathSegmentPattern.MatchString(candidateKey) {
				optKey = candidateKey
				i = eqIdx + 1
			}
		}

		if i >= n {
			return nil, nil, fmt.Errorf("unexpected end of input after '='")
		}

		var arg helperArg
		c := remainder[i]
		if c == '\'' || c == '"' {
			quote := c
			i++
			var sb strings.Builder
			for i < n && remainder[i] != quote {
				if remainder[i] == '\\' && i+1 < n && remainder[i+1] == quote {
					sb.WriteByte(quote)
					i += 2
					continue
				}
				sb.WriteByte(remainder[i])
				i++
			}
			if i >= n {
				return nil, nil, fmt.Errorf("unclosed quote in template helper")
			}
			i++
			arg = helperArg{isLiteral: true, strVal: sb.String()}
		} else {
			start := i
			for i < n && remainder[i] != ' ' && remainder[i] != '\t' && remainder[i] != '\r' && remainder[i] != '\n' {
				i++
			}
			token := remainder[start:i]
			switch strings.ToLower(token) {
			case "true":
				arg = helperArg{isLiteral: true, isBool: true, boolVal: true, strVal: "true"}
			case "false":
				arg = helperArg{isLiteral: true, isBool: true, boolVal: false, strVal: "false"}
			default:
				if _, err := strconv.Atoi(token); err == nil {
					arg = helperArg{isLiteral: true, strVal: token}
				} else if templatePlaceholderPattern.MatchString("{{" + token + "}}") {
					arg = helperArg{isVar: true, varPath: token}
				} else {
					return nil, nil, fmt.Errorf("invalid token %q in template helper", token)
				}
			}
		}

		if optKey != "" {
			options[strings.ToLower(optKey)] = arg
		} else {
			posArgs = append(posArgs, arg)
		}
	}

	return posArgs, options, nil
}

func parseTemplateTag(raw string) (*parsedTemplateTag, error) {
	inner := strings.TrimSpace(raw)
	if inner == "" {
		return nil, fmt.Errorf("empty placeholder")
	}

	// 1. Standard variable placeholder {{path.to.value}}
	if templatePlaceholderPattern.MatchString("{{" + inner + "}}") {
		return &parsedTemplateTag{
			raw:     raw,
			tagType: tagTypeVariable,
			varPath: inner,
		}, nil
	}

	// 2. Helper invocation e.g. {{barcode '128' trackingId}} or {{qrcode url}}
	fields := strings.Fields(inner)
	if len(fields) == 0 {
		return nil, fmt.Errorf("empty tag")
	}
	candidateHelper := strings.ToLower(fields[0])
	if !isKnownHelper(candidateHelper) {
		return nil, fmt.Errorf("unrecognized template tag or helper %q", candidateHelper)
	}

	remainder := strings.TrimSpace(inner[len(fields[0]):])
	posArgs, options, err := parseHelperArgs(remainder)
	if err != nil {
		return nil, err
	}

	return &parsedTemplateTag{
		raw:        raw,
		tagType:    tagTypeHelper,
		helperName: candidateHelper,
		posArgs:    posArgs,
		options:    options,
	}, nil
}

func executeTemplateHelper(tag *parsedTemplateTag, values map[string]any) (string, error) {
	name := strings.ToLower(tag.helperName)
	switch name {
	case "qrcode", "qr-code", "qr_code", "qr":
		if len(tag.posArgs) < 1 {
			return "", fmt.Errorf("qrcode helper requires a value argument, e.g. {{qrcode url}}")
		}
		val := tag.posArgs[0].resolve(values)

		size := ""
		if opt, ok := tag.options["size"]; ok {
			size = opt.resolve(values)
		} else if len(tag.posArgs) >= 2 {
			size = tag.posArgs[1].resolve(values)
		}

		level := ""
		if opt, ok := tag.options["level"]; ok {
			level = opt.resolve(values)
		} else if len(tag.posArgs) >= 3 {
			level = tag.posArgs[2].resolve(values)
		}

		fgColor := ""
		if opt, ok := tag.options["color"]; ok {
			fgColor = opt.resolve(values)
		} else if opt, ok := tag.options["fg"]; ok {
			fgColor = opt.resolve(values)
		}

		bgColor := ""
		if opt, ok := tag.options["background"]; ok {
			bgColor = opt.resolve(values)
		} else if opt, ok := tag.options["bg"]; ok {
			bgColor = opt.resolve(values)
		}

		class := ""
		if opt, ok := tag.options["class"]; ok {
			class = opt.resolve(values)
		}

		id := ""
		if opt, ok := tag.options["id"]; ok {
			id = opt.resolve(values)
		}

		style := ""
		if opt, ok := tag.options["style"]; ok {
			style = opt.resolve(values)
		}

		return generateQRCodeSVG(val, size, level, fgColor, bgColor, class, id, style)

	case "barcode":
		if len(tag.posArgs) < 2 {
			return "", fmt.Errorf("barcode helper requires at least 2 arguments: type and value, e.g. {{barcode '128' trackingId}}")
		}
		bType := tag.posArgs[0].resolve(values)
		val := tag.posArgs[1].resolve(values)

		width := ""
		if opt, ok := tag.options["width"]; ok {
			width = opt.resolve(values)
		} else if len(tag.posArgs) >= 3 {
			width = tag.posArgs[2].resolve(values)
		}

		height := ""
		if opt, ok := tag.options["height"]; ok {
			height = opt.resolve(values)
		} else if len(tag.posArgs) >= 4 {
			height = tag.posArgs[3].resolve(values)
		}

		showText := true
		if opt, ok := tag.options["text"]; ok {
			showText = opt.resolveBool(values, true)
		}

		fgColor := ""
		if opt, ok := tag.options["color"]; ok {
			fgColor = opt.resolve(values)
		}

		bgColor := ""
		if opt, ok := tag.options["background"]; ok {
			bgColor = opt.resolve(values)
		} else if opt, ok := tag.options["bg"]; ok {
			bgColor = opt.resolve(values)
		}

		class := ""
		if opt, ok := tag.options["class"]; ok {
			class = opt.resolve(values)
		}

		id := ""
		if opt, ok := tag.options["id"]; ok {
			id = opt.resolve(values)
		}

		style := ""
		if opt, ok := tag.options["style"]; ok {
			style = opt.resolve(values)
		}

		return generateBarcodeSVG(bType, val, width, height, showText, fgColor, bgColor, class, id, style)

	default:
		return "", fmt.Errorf("unsupported template helper %q", tag.helperName)
	}
}
