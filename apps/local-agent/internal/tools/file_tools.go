package tools

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"kimi-cowork/apps/local-agent/internal/policy"
)

const DefaultMaxReadBytes int64 = 256 * 1024

type FileEntry struct {
	Path  string `json:"path"`
	IsDir bool   `json:"is_dir"`
	Size  int64  `json:"size"`
}

type ReadResult struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Text   string `json:"text"`
}

func ListFiles(root string, maxEntries int) ([]FileEntry, error) {
	trustedRoot, err := policy.AssertTrustedPath(root, root)
	if err != nil {
		return nil, err
	}
	if maxEntries <= 0 {
		maxEntries = 500
	}
	entries := make([]FileEntry, 0)
	err = filepath.WalkDir(trustedRoot, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path != trustedRoot && policy.IsSensitivePath(path) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() && shouldSkipDir(d.Name()) && path != trustedRoot {
			return filepath.SkipDir
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		entries = append(entries, FileEntry{Path: path, IsDir: d.IsDir(), Size: info.Size()})
		if len(entries) >= maxEntries {
			return filepath.SkipAll
		}
		return nil
	})
	return entries, err
}

func ReadTextFile(path string, trustedRoot string, maxBytes int64) (ReadResult, error) {
	safe, err := policy.AssertTrustedPath(path, trustedRoot)
	if err != nil {
		return ReadResult{}, err
	}
	if maxBytes <= 0 {
		maxBytes = DefaultMaxReadBytes
	}
	info, err := os.Stat(safe)
	if err != nil {
		return ReadResult{}, err
	}
	if info.IsDir() {
		return ReadResult{}, errors.New("cannot read directory as file")
	}
	if info.Size() > maxBytes {
		return ReadResult{}, errors.New("file exceeds max read size")
	}
	data, err := os.ReadFile(safe)
	if err != nil {
		return ReadResult{}, err
	}
	if looksBinary(data) {
		return ReadResult{}, errors.New("binary file blocked")
	}
	sum := sha256.Sum256(data)
	return ReadResult{Path: safe, Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:]), Text: string(data)}, nil
}

func HashFile(path string, trustedRoot string) (string, error) {
	safe, err := policy.AssertTrustedPath(path, trustedRoot)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(safe)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func shouldSkipDir(name string) bool {
	switch strings.ToLower(name) {
	case ".git", "node_modules", "dist", "build", ".kimicowork":
		return true
	default:
		return false
	}
}

func looksBinary(data []byte) bool {
	if len(data) == 0 {
		return false
	}
	for _, b := range data {
		if b == 0 {
			return true
		}
	}
	return false
}
