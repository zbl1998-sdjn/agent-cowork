package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"

	"kimi-cowork/apps/local-agent/internal/journal"
	"kimi-cowork/apps/local-agent/internal/tools"
)

const version = "0.1.0-v0.3"

type healthPayload struct {
	OK      bool   `json:"ok"`
	Service string `json:"service"`
	Version string `json:"version"`
}

type listPayload struct {
	Root  string            `json:"root"`
	Files []tools.FileEntry `json:"files"`
}

type applyPayload struct {
	OK      bool   `json:"ok"`
	Applied int    `json:"applied"`
	BatchID string `json:"batch_id"`
	Journal string `json:"journal,omitempty"`
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "kimi-cowork-agent: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return printJSON(healthPayload{OK: true, Service: "kimi-cowork-agent", Version: version})
	}
	if args[0] == "-version" || args[0] == "--version" {
		fmt.Println(version)
		return nil
	}

	switch args[0] {
	case "health":
		return printJSON(healthPayload{OK: true, Service: "kimi-cowork-agent", Version: version})
	case "list":
		return runList(args[1:])
	case "read":
		return runRead(args[1:])
	case "apply":
		return runApply(args[1:])
	default:
		return fmt.Errorf("unknown command %q; expected health, list, read, or apply", args[0])
	}
}

func runList(args []string) error {
	flags := flag.NewFlagSet("list", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	root := flags.String("root", "", "trusted workspace root")
	maxEntries := flags.Int("max", 500, "maximum entries")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" {
		return errors.New("list requires --root")
	}

	files, err := tools.ListFiles(*root, *maxEntries)
	if err != nil {
		return err
	}
	return printJSON(listPayload{Root: *root, Files: files})
}

func runRead(args []string) error {
	flags := flag.NewFlagSet("read", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	root := flags.String("root", "", "trusted workspace root")
	filePath := flags.String("path", "", "file path to read")
	maxBytes := flags.Int64("max-bytes", 0, "maximum read bytes")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" {
		return errors.New("read requires --root")
	}
	if *filePath == "" {
		return errors.New("read requires --path")
	}

	result, err := tools.ReadTextFile(*filePath, *root, *maxBytes)
	if err != nil {
		return err
	}
	return printJSON(result)
}

func runApply(args []string) error {
	flags := flag.NewFlagSet("apply", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	root := flags.String("root", "", "trusted workspace root")
	opsPath := flags.String("ops", "", "JSON file containing an array of operations")
	journalPath := flags.String("journal", "", "JSONL audit journal path")
	batchID := flags.String("batch", "cli", "batch id for audit journal")
	allowOverwrite := flags.Bool("allow-overwrite", false, "allow overwriting existing targets")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" {
		return errors.New("apply requires --root")
	}
	if *opsPath == "" {
		return errors.New("apply requires --ops")
	}

	ops, err := readOperations(*opsPath)
	if err != nil {
		return err
	}
	options := tools.ApplyOptions{
		TrustedRoot:    *root,
		BatchID:        *batchID,
		AllowOverwrite: *allowOverwrite,
	}
	if *journalPath != "" {
		options.Journal = journal.NewWriter(*journalPath)
	}
	if err := tools.ApplyOperations(ops, options); err != nil {
		return err
	}
	return printJSON(applyPayload{OK: true, Applied: len(ops), BatchID: *batchID, Journal: *journalPath})
}

func readOperations(path string) ([]tools.FileOperation, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var ops []tools.FileOperation
	if err := json.Unmarshal(data, &ops); err != nil {
		return nil, err
	}
	if len(ops) == 0 {
		return nil, errors.New("operations file is empty")
	}
	return ops, nil
}

func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
