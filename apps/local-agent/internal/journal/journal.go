// Package journal 是 local-agent 的审计日志(apps/local-agent · Go)。
// 职责:把文件操作以 JSONL 逐行追加写入审计 journal(并发安全),为「副作用先批准 + 留痕」提供不可抵赖记录。
// 依赖:仅标准库。导出:Event / Writer。
package journal

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Event struct {
	BatchID     string `json:"batch_id"`
	OperationID string `json:"op_id"`
	Type        string `json:"type"`
	From        string `json:"from,omitempty"`
	To          string `json:"to,omitempty"`
	BeforeHash  string `json:"before_hash,omitempty"`
	AfterHash   string `json:"after_hash,omitempty"`
	Status      string `json:"status"`
	CreatedAt   string `json:"created_at"`
}

type Writer struct {
	path string
	mu   sync.Mutex
}

func NewWriter(path string) *Writer {
	return &Writer{path: path}
}

func (w *Writer) Append(event Event) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if event.CreatedAt == "" {
		event.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if err := os.MkdirAll(filepath.Dir(w.path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(w.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	line, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err := file.Write(append(line, '\n')); err != nil {
		return err
	}
	return nil
}
