package kimi

import (
	"errors"
	"time"
)

type RetryPolicy struct {
	MaxAttempts int
	Backoff     time.Duration
}

func (p RetryPolicy) Validate() error {
	if p.MaxAttempts <= 0 {
		return errors.New("max attempts must be positive")
	}
	if p.MaxAttempts > 5 {
		return errors.New("max attempts must be bounded to 5 or fewer")
	}
	if p.Backoff < 0 {
		return errors.New("backoff cannot be negative")
	}
	return nil
}
