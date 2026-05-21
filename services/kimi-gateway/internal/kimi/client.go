package kimi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func NewClient(baseURL string, apiKey string, timeout time.Duration) Client {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		APIKey:  apiKey,
		HTTPClient: &http.Client{
			Timeout: timeout,
		},
		RetryPolicy: RetryPolicy{
			MaxAttempts: 2,
			Backoff:     200 * time.Millisecond,
		},
	}
}

func (c Client) Chat(ctx context.Context, request ChatRequest) (ChatResponse, error) {
	if err := c.validateChatRequest(request); err != nil {
		return ChatResponse{}, err
	}

	policy := c.effectiveRetryPolicy()
	if err := policy.Validate(); err != nil {
		return ChatResponse{}, err
	}
	httpClient := c.effectiveHTTPClient()
	if !c.breakerAllows() {
		return ChatResponse{}, errors.New("kimi circuit breaker is open")
	}

	var lastErr error
	retryableFailure := false
	for attempt := 1; attempt <= policy.MaxAttempts; attempt++ {
		baseURL, apiKey, err := c.endpointForAttempt(attempt)
		if err != nil {
			return ChatResponse{}, err
		}
		response, retry, err := c.chatOnce(ctx, httpClient, request, baseURL, apiKey)
		if err == nil {
			c.recordBreakerSuccess()
			return response, nil
		}
		lastErr = err
		if retry {
			retryableFailure = true
		}
		if !retry || attempt == policy.MaxAttempts {
			break
		}
		if err := waitBackoff(ctx, policy.Backoff); err != nil {
			if retryableFailure {
				c.recordBreakerFailure()
			}
			return ChatResponse{}, err
		}
	}
	if retryableFailure {
		c.recordBreakerFailure()
	}
	return ChatResponse{}, lastErr
}

func (c Client) ChatStream(ctx context.Context, request ChatRequest, emit func(StreamEvent) error) error {
	if emit == nil {
		return errors.New("stream emitter is required")
	}
	if err := c.validateChatRequest(request); err != nil {
		return err
	}
	request.Stream = true

	policy := c.effectiveRetryPolicy()
	if err := policy.Validate(); err != nil {
		return err
	}
	httpClient := c.effectiveHTTPClient()
	if !c.breakerAllows() {
		return errors.New("kimi circuit breaker is open")
	}

	var lastErr error
	retryableFailure := false
	for attempt := 1; attempt <= policy.MaxAttempts; attempt++ {
		baseURL, apiKey, err := c.endpointForAttempt(attempt)
		if err != nil {
			return err
		}
		retry, err := c.streamOnce(ctx, httpClient, request, baseURL, apiKey, emit)
		if err == nil {
			c.recordBreakerSuccess()
			return nil
		}
		lastErr = err
		if retry {
			retryableFailure = true
		}
		if !retry || attempt == policy.MaxAttempts {
			break
		}
		if err := waitBackoff(ctx, policy.Backoff); err != nil {
			if retryableFailure {
				c.recordBreakerFailure()
			}
			return err
		}
	}
	if retryableFailure {
		c.recordBreakerFailure()
	}
	return lastErr
}

func (c Client) chatOnce(ctx context.Context, httpClient *http.Client, chat ChatRequest, baseURL string, apiKey string) (ChatResponse, bool, error) {
	payload, err := json.Marshal(chat)
	if err != nil {
		return ChatResponse{}, false, err
	}

	response, retry, err := c.doChatRequest(ctx, httpClient, baseURL, apiKey, payload, "application/json")
	if err != nil {
		return ChatResponse{}, retry, err
	}
	defer response.Body.Close()

	body, readErr := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if readErr != nil {
		return ChatResponse{}, true, readErr
	}
	parsed, err := parseOpenAICompatibleResponse(body)
	if err != nil {
		return ChatResponse{}, false, err
	}
	return parsed, false, nil
}

func (c Client) streamOnce(ctx context.Context, httpClient *http.Client, chat ChatRequest, baseURL string, apiKey string, emit func(StreamEvent) error) (bool, error) {
	payload, err := json.Marshal(chat)
	if err != nil {
		return false, err
	}
	response, retry, err := c.doChatRequest(ctx, httpClient, baseURL, apiKey, payload, "text/event-stream")
	if err != nil {
		return retry, err
	}
	defer response.Body.Close()

	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	sawPayload := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			return false, emit(StreamEvent{Type: StreamEventDone, Done: true})
		}
		sawPayload = true
		if err := emitStreamPayload(data, emit); err != nil {
			return false, err
		}
	}
	if err := scanner.Err(); err != nil {
		return true, err
	}
	return !sawPayload, errors.New("kimi stream ended before [DONE]")
}

func (c Client) doChatRequest(ctx context.Context, httpClient *http.Client, baseURL string, apiKey string, payload []byte, accept string) (*http.Response, bool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	endpoint := strings.TrimRight(baseURL, "/") + "/chat/completions"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, false, err
	}
	request.Header.Set("authorization", "Bearer "+apiKey)
	request.Header.Set("content-type", "application/json")
	request.Header.Set("accept", accept)

	response, err := httpClient.Do(request)
	if err != nil {
		return nil, true, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
		return nil, isRetryableStatus(response.StatusCode), fmt.Errorf("kimi chat failed with status %d", response.StatusCode)
	}
	return response, false, nil
}

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
