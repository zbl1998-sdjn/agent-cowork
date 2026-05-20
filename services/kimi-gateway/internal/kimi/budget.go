package kimi

import "errors"

type Budget struct {
	MaxInputTokens  int
	MaxOutputTokens int
}

func (b Budget) Validate() error {
	if b.MaxInputTokens <= 0 {
		return errors.New("max input tokens must be positive")
	}
	if b.MaxOutputTokens <= 0 {
		return errors.New("max output tokens must be positive")
	}
	return nil
}
