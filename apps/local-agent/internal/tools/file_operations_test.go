package tools

import (
	"os"
	"path/filepath"
	"testing"

	"agent-cowork/apps/local-agent/internal/journal"
)

// 本地 agent 的批量文件操作默认不允许删除,防止模型计划把破坏性动作伪装成普通补丁。
func TestApplyOperationsForbidsDelete(t *testing.T) {
	err := ApplyOperations([]FileOperation{{ID: "op1", Type: "delete", From: "a.txt"}}, ApplyOptions{TrustedRoot: t.TempDir()})
	if err == nil {
		t.Fatal("expected delete to be forbidden")
	}
}

// 写入操作不能覆盖既有文件,要求调用方显式走更高层审批/备份路径处理覆盖语义。
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

// 成功写入必须留下 jsonl 审计记录,后续验收和回滚都依赖这条持久证据。
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
