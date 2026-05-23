package tools

import (
	"os"
	"path/filepath"
	"testing"

	"agent-cowork/apps/local-agent/internal/journal"
)

func TestApplyOperationsForbidsDelete(t *testing.T) {
	err := ApplyOperations([]FileOperation{{ID: "op1", Type: "delete", From: "a.txt"}}, ApplyOptions{TrustedRoot: t.TempDir()})
	if err == nil {
		t.Fatal("expected delete to be forbidden")
	}
}

func TestApplyOperationsForbidsOverwrite(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "a.txt")
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := ApplyOperations([]FileOperation{{ID: "op1", Type: "write", To: target, Content: "new"}}, ApplyOptions{TrustedRoot: root})
	if err == nil {
		t.Fatal("expected overwrite to be forbidden")
	}
}

func TestApplyOperationsWritesJournal(t *testing.T) {
	root := t.TempDir()
	journalPath := filepath.Join(root, "audit", "ops.jsonl")
	err := ApplyOperations(
		[]FileOperation{{ID: "op1", Type: "write", To: filepath.Join(root, "out.md"), Content: "hello"}},
		ApplyOptions{TrustedRoot: root, BatchID: "batch1", Journal: journal.NewWriter(journalPath)},
	)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 {
		t.Fatal("expected journal data")
	}
}
