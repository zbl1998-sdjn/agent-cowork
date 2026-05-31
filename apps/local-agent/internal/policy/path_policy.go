// Package policy 是 local-agent 的路径安全策略(apps/local-agent · Go)。
// 职责:把候选路径收敛进「可信根」之内并拦截敏感文件/目录,是文件工具的安全闸门;
// 镜像 Node host 的 path-policy(含 Windows 8.3 短名/符号链接的一致规范化)。
// 导出:Canonical / AssertTrustedPath / IsSensitivePath。
package policy

import (
	"fmt"
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
	// 快路径:整条路径都存在 —— EvalSymlinks 解析符号链接,并(在 Windows 上)把 8.3 短名
	// (如 ADMINI~1)解析成规范长名。
	if real, evalErr := filepath.EvalSymlinks(abs); evalErr == nil {
		return real, nil
	}
	// 路径尚未完整存在(如尚未创建的写入目标):向上找到「最近的已存在祖先」并对其规范化,再拼回
	// 缺失尾段。这样可信根与其子路径会被「一致地」规范化(同样解析 8.3 短名/符号链接),避免出现
	// 「根是长名、子是短名」而误判越界。与 Node host 的 canonicalizePath 行为对齐。
	missing := []string{}
	cur := abs
	for {
		parent := filepath.Dir(cur)
		if parent == cur {
			break // 到达卷根(如 C:\),无法再向上
		}
		missing = append([]string{filepath.Base(cur)}, missing...)
		cur = parent
		if real, evalErr := filepath.EvalSymlinks(cur); evalErr == nil {
			return filepath.Join(append([]string{real}, missing...)...), nil
		}
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
	// 敏感性检查:目录段仅在可信根 root 之下扫描(根自身位于 AppData/Temp 等目录下时不应误伤)。
	if IsSensitivePath(target, root) {
		return "", fmt.Errorf("sensitive path blocked: %s", candidate)
	}
	return target, nil
}

// IsSensitivePath 判断路径是否敏感:文件名/扩展名命中黑名单「始终」拦截;敏感「目录段」仅在可信根
// relativeTo 之下才检查(relativeTo 为空则检查全路径段)。这样当可信根本身位于含 appdata 等段的目录下
// 时,不会把根的祖先段误判为敏感而拦掉所有操作。与 Node host 的 isSensitivePath(path, relativeTo) 对齐。
func IsSensitivePath(path string, relativeTo string) bool {
	clean := comparePath(path)
	base := strings.ToLower(filepath.Base(clean))
	ext := strings.ToLower(filepath.Ext(base))

	// 文件名 / 扩展名 —— 始终检查(无论是否在根之下)。
	if _, ok := sensitiveNames[base]; ok {
		return true
	}
	if strings.HasPrefix(base, ".env") || strings.HasPrefix(base, "id_rsa") {
		return true
	}
	if _, ok := sensitiveExts[ext]; ok {
		return true
	}

	// 目录段 —— 限定在可信根之下扫描。
	segments := segmentsBelowRoot(clean, relativeTo)
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

// segmentsBelowRoot 返回 path 在 relativeTo 之下的路径段;relativeTo 为空或 path 不在其下时返回全部段。
// 入参应已是 comparePath 归一化后的路径。
func segmentsBelowRoot(clean string, relativeTo string) []string {
	split := func(s string) []string {
		return strings.FieldsFunc(s, func(r rune) bool { return r == '/' || r == '\\' })
	}
	if relativeTo == "" {
		return split(clean)
	}
	root := comparePath(relativeTo)
	if clean == root {
		return nil
	}
	rootWithSep := root
	if !strings.HasSuffix(rootWithSep, string(filepath.Separator)) {
		rootWithSep += string(filepath.Separator)
	}
	if strings.HasPrefix(clean, rootWithSep) {
		return split(clean[len(rootWithSep):])
	}
	return split(clean)
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
