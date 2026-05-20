//go:build cli_smoke

package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"kimi-cowork/apps/local-agent/internal/tools"
)

func TestCLIEndToEnd(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "contracts"))
	mustMkdir(t, filepath.Join(root, "notes"))

	contractPath := filepath.Join(root, "contracts", "sample-contract.txt")
	notePath := filepath.Join(root, "notes", "weekly.md")
	artifactPath := filepath.Join(root, ".KimiCowork", "artifacts", "agent-summary.md")
	renamedNotePath := filepath.Join(root, "notes", "weekly-renamed.md")
	movedContractPath := filepath.Join(root, "Kimi_Cowork整理", "合同审核", "sample-contract.txt")
	journalPath := filepath.Join(root, ".KimiCowork", "audit", "agent.jsonl")
	opsPath := filepath.Join(root, "ops.json")

	mustWrite(t, contractPath, "Contract draft. Party A, Party B, renewal date, payment terms.")
	mustWrite(t, notePath, "# Weekly meeting\n- Follow up with procurement\n- Prepare summary")

	healthOutput, err := captureRun("health")
	if err != nil {
		t.Fatalf("health failed: %v", err)
	}
	var health healthPayload
	if err := json.Unmarshal([]byte(healthOutput), &health); err != nil {
		t.Fatalf("health JSON failed: %v\n%s", err, healthOutput)
	}
	if !health.OK || health.Service != "kimi-cowork-agent" {
		t.Fatalf("unexpected health payload: %+v", health)
	}

	listOutput, err := captureRun("list", "--root", root, "--max", "100")
	if err != nil {
		t.Fatalf("list failed: %v", err)
	}
	var listed listPayload
	if err := json.Unmarshal([]byte(listOutput), &listed); err != nil {
		t.Fatalf("list JSON failed: %v\n%s", err, listOutput)
	}
	if !containsPathSuffix(listed.Files, "sample-contract.txt") {
		t.Fatalf("list output missing contract: %+v", listed.Files)
	}

	readOutput, err := captureRun("read", "--root", root, "--path", contractPath, "--max-bytes", "4096")
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}
	if !strings.Contains(readOutput, "renewal date") || !strings.Contains(readOutput, `"sha256"`) {
		t.Fatalf("read output missing content/hash: %s", readOutput)
	}

	ops := []map[string]string{
		{"id": "write-summary", "type": "write", "to": artifactPath, "content": "# Agent Summary\n\n- Local agent smoke passed.\n"},
		{"id": "rename-note", "type": "rename", "from": notePath, "to": renamedNotePath},
		{"id": "move-contract", "type": "move", "from": contractPath, "to": movedContractPath},
	}
	writeJSON(t, opsPath, ops)

	applyOutput, err := captureRun("apply", "--root", root, "--ops", opsPath, "--journal", journalPath, "--batch", "agent-smoke")
	if err != nil {
		t.Fatalf("apply failed: %v\n%s", err, applyOutput)
	}
	var applied applyPayload
	if err := json.Unmarshal([]byte(applyOutput), &applied); err != nil {
		t.Fatalf("apply JSON failed: %v\n%s", err, applyOutput)
	}
	if !applied.OK || applied.Applied != 3 {
		t.Fatalf("unexpected apply payload: %+v", applied)
	}
	assertExists(t, artifactPath)
	assertExists(t, renamedNotePath)
	assertMissing(t, notePath)
	assertExists(t, movedContractPath)
	assertMissing(t, contractPath)

	blockedTarget := filepath.Join(root, ".KimiCowork", "artifacts", "blocked.md")
	blockedOpsPath := filepath.Join(root, "blocked-ops.json")
	mustWrite(t, blockedTarget, "existing target")
	writeJSON(t, blockedOpsPath, []map[string]string{
		{"id": "blocked-move", "type": "move", "from": renamedNotePath, "to": blockedTarget},
	})
	if _, err := captureRun("apply", "--root", root, "--ops", blockedOpsPath, "--journal", journalPath, "--batch", "blocked"); err == nil {
		t.Fatal("expected blocked move to fail")
	}
	assertExists(t, renamedNotePath)

	journalData, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatalf("read journal: %v", err)
	}
	journalText := string(journalData)
	for _, want := range []string{`"type":"write"`, `"type":"rename"`, `"type":"move"`, `"status":"done"`} {
		if !strings.Contains(journalText, want) {
			t.Fatalf("journal missing %s: %s", want, journalText)
		}
	}
}

func captureRun(args ...string) (string, error) {
	oldStdout := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		return "", err
	}
	os.Stdout = writer

	runErr := run(args)
	closeErr := writer.Close()
	os.Stdout = oldStdout
	if closeErr != nil && runErr == nil {
		runErr = closeErr
	}

	data, readErr := io.ReadAll(reader)
	if readErr != nil {
		return "", readErr
	}
	_ = reader.Close()
	return string(data), runErr
}

func containsPathSuffix(entries []tools.FileEntry, suffix string) bool {
	for _, row := range entries {
		if strings.HasSuffix(row.Path, suffix) {
			return true
		}
	}
	return false
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}

func mustWrite(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir parent %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal JSON: %v", err)
	}
	mustWrite(t, path, string(data))
}

func assertExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected %s to exist: %v", path, err)
	}
}

func assertMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err == nil {
		t.Fatalf("expected %s to be missing", path)
	}
}
