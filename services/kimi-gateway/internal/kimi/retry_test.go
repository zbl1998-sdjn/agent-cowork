package kimi

import (
	"testing"
	"time"
)

func TestRetryPolicyIsBounded(t *testing.T) {
	if err := (RetryPolicy{MaxAttempts: 6, Backoff: time.Second}).Validate(); err == nil {
		t.Fatal("expected excessive attempts to be rejected")
	}
	if err := (RetryPolicy{MaxAttempts: 3, Backoff: time.Second}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestBudgetRequiresPositiveValues(t *testing.T) {
	if err := (Budget{MaxInputTokens: 1, MaxOutputTokens: 1}).Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (Budget{MaxInputTokens: 0, MaxOutputTokens: 1}).Validate(); err == nil {
		t.Fatal("expected invalid budget")
	}
}
