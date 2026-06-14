package kimi

import (
	"testing"
	"time"
)

// 重试次数必须有硬边界,避免网关在上游异常时无限放大请求和延迟。
func TestRetryPolicyIsBounded(t *testing.T) {
	if err := (RetryPolicy{MaxAttempts: 6, Backoff: time.Second}).Validate(); err == nil {
		t.Fatal("expected excessive attempts to be rejected")
	}
	if err := (RetryPolicy{MaxAttempts: 3, Backoff: time.Second}).Validate(); err != nil {
		t.Fatal(err)
	}
}

// token 预算必须为正数,否则后续模型请求无法形成可解释的成本与截断策略。
func TestBudgetRequiresPositiveValues(t *testing.T) {
	if err := (Budget{MaxInputTokens: 1, MaxOutputTokens: 1}).Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (Budget{MaxInputTokens: 0, MaxOutputTokens: 1}).Validate(); err == nil {
		t.Fatal("expected invalid budget")
	}
}
