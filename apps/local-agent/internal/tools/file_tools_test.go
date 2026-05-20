package tools

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadTextFileAndHash(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "note.md")
	if err := os.WriteFile(file, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ReadTextFile(file, root, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "hello" {
		t.Fatalf("unexpected text: %q", got.Text)
	}
	if got.SHA256 == "" {
		t.Fatal("expected hash")
	}
}

func TestReadTextFileRejectsSensitive(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, ".env")
	if err := os.WriteFile(file, []byte("KEY=value"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadTextFile(file, root, 0); err == nil {
		t.Fatal("expected sensitive file to be rejected")
	}
}

func TestListFilesSkipsNoisyDirectories(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "visible.txt"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, err := ListFiles(root, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if filepath.Base(entry.Path) == ".git" {
			t.Fatal("expected .git to be skipped")
		}
	}
}
