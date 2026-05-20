package policy

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

var sensitiveSegments = map[string]struct{}{
	".ssh":        {},
	".kimi":       {},
	"credentials": {},
	"appdata":     {},
}

var sensitiveNames = map[string]struct{}{
	".env":       {},
	"id_rsa":     {},
	"id_dsa":     {},
	"id_ecdsa":   {},
	"id_ed25519": {},
}

var sensitiveExts = map[string]struct{}{
	".pem": {},
	".key": {},
}

func Canonical(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err == nil {
		return real, nil
	}
	if os.IsNotExist(err) {
		return abs, nil
	}
	return abs, nil
}

func AssertTrustedPath(candidate string, trustedRoot string) (string, error) {
	root, err := Canonical(trustedRoot)
	if err != nil {
		return "", err
	}
	target := candidate
	if !filepath.IsAbs(target) {
		target = filepath.Join(root, target)
	}
	target, err = Canonical(target)
	if err != nil {
		return "", err
	}

	if !isWithin(target, root) {
		return "", fmt.Errorf("path escaped trusted root: %s", candidate)
	}
	if IsSensitivePath(target) {
		return "", fmt.Errorf("sensitive path blocked: %s", candidate)
	}
	return target, nil
}

func IsSensitivePath(path string) bool {
	clean := comparePath(path)
	segments := strings.FieldsFunc(clean, func(r rune) bool {
		return r == '/' || r == '\\'
	})
	base := strings.ToLower(filepath.Base(clean))
	ext := strings.ToLower(filepath.Ext(base))

	if _, ok := sensitiveNames[base]; ok {
		return true
	}
	if strings.HasPrefix(base, ".env") || strings.HasPrefix(base, "id_rsa") {
		return true
	}
	if _, ok := sensitiveExts[ext]; ok {
		return true
	}
	for i, segment := range segments {
		segment = strings.ToLower(segment)
		if _, ok := sensitiveSegments[segment]; ok {
			return true
		}
		if segment == ".kimi" && i+1 < len(segments) && strings.ToLower(segments[i+1]) == "credentials" {
			return true
		}
	}
	return false
}

func isWithin(target string, root string) bool {
	t := comparePath(target)
	r := comparePath(root)
	if t == r {
		return true
	}
	if !strings.HasSuffix(r, string(filepath.Separator)) {
		r += string(filepath.Separator)
	}
	return strings.HasPrefix(t, r)
}

func comparePath(path string) string {
	clean := filepath.Clean(path)
	if runtime.GOOS == "windows" {
		return strings.ToLower(clean)
	}
	return clean
}
