package kimi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
)

func (c Client) validateChatRequest(request ChatRequest) error {
	if strings.TrimSpace(request.Model) == "" {
		return errors.New("model is required")
	}
	if len(request.Messages) == 0 {
		return errors.New("at least one message is required")
	}
	for _, message := range request.Messages {
		if strings.TrimSpace(message.Role) == "" || !hasMessageContent(message.Content) {
			return errors.New("message role and content are required")
		}
	}
	if len(c.baseURLs()) == 0 {
		return errors.New("base URL is required")
	}
	if len(c.apiKeys()) == 0 {
		return errors.New("API key is required")
	}
	return nil
}

func (c Client) effectiveHTTPClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (c Client) effectiveRetryPolicy() RetryPolicy {
	if c.RetryPolicy.MaxAttempts == 0 {
		return RetryPolicy{MaxAttempts: 1}
	}
	return c.RetryPolicy
}

func (c Client) baseURLs() []string {
	var out []string
	for _, baseURL := range append([]string{c.BaseURL}, c.BaseURLs...) {
		baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
		if baseURL != "" {
			out = append(out, baseURL)
		}
	}
	return out
}

func (c Client) apiKeys() []string {
	var out []string
	for _, apiKey := range append([]string{c.APIKey}, c.APIKeys...) {
		apiKey = strings.TrimSpace(apiKey)
		if apiKey != "" {
			out = append(out, apiKey)
		}
	}
	return out
}

func (c Client) endpointForAttempt(attempt int) (string, string, error) {
	baseURLs := c.baseURLs()
	apiKeys := c.apiKeys()
	if len(baseURLs) == 0 {
		return "", "", errors.New("base URL is required")
	}
	if len(apiKeys) == 0 {
		return "", "", errors.New("API key is required")
	}
	if attempt < 1 {
		attempt = 1
	}
	return baseURLs[(attempt-1)%len(baseURLs)], apiKeys[(attempt-1)%len(apiKeys)], nil
}

func (c Client) breakerAllows() bool {
	if c.Breaker == nil {
		return true
	}
	return c.Breaker.Allow(time.Now())
}

func (c Client) recordBreakerSuccess() {
	if c.Breaker != nil {
		c.Breaker.RecordSuccess()
	}
}

func (c Client) recordBreakerFailure() {
	if c.Breaker != nil {
		c.Breaker.RecordFailure(time.Now())
	}
}

func waitBackoff(ctx context.Context, backoff time.Duration) error {
	if backoff <= 0 {
		return nil
	}
	timer := time.NewTimer(backoff)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func isRetryableStatus(status int) bool {
	return status == http.StatusTooManyRequests || status == http.StatusRequestTimeout || status >= 500
}
