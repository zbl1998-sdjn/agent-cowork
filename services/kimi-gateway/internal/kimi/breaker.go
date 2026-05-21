package kimi

import (
	"sync"
	"time"
)

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
