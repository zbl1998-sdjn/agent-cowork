package policy

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAssertTrustedPathRejectsEscape(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(os.TempDir(), "outside.txt")
	if _, err := AssertTrustedPath(outside, root); err == nil {
		t.Fatal("expected escaped path to be rejected")
	}
}

func TestAssertTrustedPathRejectsSensitive(t *testing.T) {
	root := t.TempDir()
	secret := filepath.Join(root, ".env")
	if _, err := AssertTrustedPath(secret, root); err == nil {
		t.Fatal("expected sensitive path to be rejected")
	}
}

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
