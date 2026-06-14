package policy

import (
	"os"
	"path/filepath"
	"testing"
)

// trusted root 是路径 jail 的边界,任何指向根目录外的路径都必须被拒绝。
func TestAssertTrustedPathRejectsEscape(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(os.TempDir(), "outside.txt")
	if _, err := AssertTrustedPath(outside, root); err == nil {
		t.Fatal("expected escaped path to be rejected")
	}
}

// 敏感文件名不因位于 trusted root 内而自动可信,避免把密钥文件暴露给工具层。
func TestAssertTrustedPathRejectsSensitive(t *testing.T) {
	root := t.TempDir()
	secret := filepath.Join(root, ".env")
	if _, err := AssertTrustedPath(secret, root); err == nil {
		t.Fatal("expected sensitive path to be rejected")
	}
}

// trusted root 内的普通子路径应返回规范化路径,让后续 IO 使用同一个安全后的值。
func TestAssertTrustedPathAcceptsChild(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "docs", "a.md")
	got, err := AssertTrustedPath(child, root)
	if err != nil {
		t.Fatalf("expected trusted child path: %v", err)
	}
	if got == "" {
		t.Fatal("expected canonical path")
	}
}
