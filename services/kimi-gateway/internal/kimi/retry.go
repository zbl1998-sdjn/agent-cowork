package kimi

import (
	"errors"
	"time"
)

// RetryPolicy 是重试策略(最多 MaxAttempts 次、间隔 Backoff);Validate 限定次数 1..5、退避非负,避免无界重试放大故障。
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
