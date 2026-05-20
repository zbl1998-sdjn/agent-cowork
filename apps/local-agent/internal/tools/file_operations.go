package tools

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"kimi-cowork/apps/local-agent/internal/journal"
	"kimi-cowork/apps/local-agent/internal/policy"
)

type FileOperation struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	From    string `json:"from,omitempty"`
	To      string `json:"to,omitempty"`
	Content string `json:"content,omitempty"`
}

type ApplyOptions struct {
	TrustedRoot    string
	BatchID        string
	AllowOverwrite bool
	Journal        *journal.Writer
}

func ApplyOperations(ops []FileOperation, options ApplyOptions) error {
	if options.TrustedRoot == "" {
		return errors.New("trusted root is required")
	}
	for _, op := range ops {
		if err := applyOperation(op, options); err != nil {
			return err
		}
	}
	return nil
}

func applyOperation(op FileOperation, options ApplyOptions) error {
	if op.ID == "" {
		return errors.New("operation id is required")
	}
	switch op.Type {
	case "write":
		return applyWrite(op, options)
	case "rename", "move":
		return applyMove(op, options)
	case "delete":
		return errors.New("delete is forbidden in MVP")
	default:
		return fmt.Errorf("unsupported operation type: %s", op.Type)
	}
}

func applyWrite(op FileOperation, options ApplyOptions) error {
	target, err := policy.AssertTrustedPath(op.To, options.TrustedRoot)
	if err != nil {
		return err
	}
	if !options.AllowOverwrite {
		if _, err := os.Stat(target); err == nil {
			return errors.New("overwrite is forbidden by default")
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	if options.Journal != nil {
		_ = options.Journal.Append(journal.Event{BatchID: options.BatchID, OperationID: op.ID, Type: op.Type, To: target, Status: "pending"})
	}
	if err := os.WriteFile(target, []byte(op.Content), 0o600); err != nil {
		return err
	}
	after, _ := HashFile(target, options.TrustedRoot)
	if options.Journal != nil {
		return options.Journal.Append(journal.Event{BatchID: options.BatchID, OperationID: op.ID, Type: op.Type, To: target, AfterHash: after, Status: "done"})
	}
	return nil
}

func applyMove(op FileOperation, options ApplyOptions) error {
	from, err := policy.AssertTrustedPath(op.From, options.TrustedRoot)
	if err != nil {
		return err
	}
	to, err := policy.AssertTrustedPath(op.To, options.TrustedRoot)
	if err != nil {
		return err
	}
	if !options.AllowOverwrite {
		if _, err := os.Stat(to); err == nil {
			return errors.New("overwrite is forbidden by default")
		}
	}
	before, _ := HashFile(from, options.TrustedRoot)
	if options.Journal != nil {
		_ = options.Journal.Append(journal.Event{BatchID: options.BatchID, OperationID: op.ID, Type: op.Type, From: from, To: to, BeforeHash: before, Status: "pending"})
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o700); err != nil {
		return err
	}
	if err := os.Rename(from, to); err != nil {
		return err
	}
	after, _ := HashFile(to, options.TrustedRoot)
	if options.Journal != nil {
		return options.Journal.Append(journal.Event{BatchID: options.BatchID, OperationID: op.ID, Type: op.Type, From: from, To: to, BeforeHash: before, AfterHash: after, Status: "done"})
	}
	return nil
}
