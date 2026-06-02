package kimi

import (
	"sync"
	"time"
)

// CircuitBreaker 是并发安全的熔断器:连续失败达到 MaxFailures 即「打开」并冷却 Cooldown,期间 Allow 返回 false 快速失败;
// 成功则复位。与 Node host 的 circuit-breaker 同思路,保护上游模型 API。
type CircuitBreaker struct {
	MaxFailures int
	Cooldown    time.Duration

	mu          sync.Mutex
	failures    int
	openedUntil time.Time
}

func (b *CircuitBreaker) Allow(now time.Time) bool {
	if b == nil {
		return true
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.openedUntil.IsZero() || !now.Before(b.openedUntil) {
		return true
	}
	return false
}

func (b *CircuitBreaker) RecordSuccess() {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.failures = 0
	b.openedUntil = time.Time{}
}

func (b *CircuitBreaker) RecordFailure(now time.Time) {
	if b == nil {
		return
	}
	maxFailures := b.MaxFailures
	if maxFailures <= 0 {
		maxFailures = 3
	}
	cooldown := b.Cooldown
	if cooldown <= 0 {
		cooldown = 30 * time.Second
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.failures++
	if b.failures >= maxFailures {
		b.openedUntil = now.Add(cooldown)
	}
}
