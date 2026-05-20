package kimi

import (
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

type Client struct {
	BaseURL     string
	APIKey      string
	HTTPClient  *http.Client
	RetryPolicy RetryPolicy
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	MaxTokens   int       `json:"max_tokens,omitempty"`
	Temperature *float64  `json:"temperature,omitempty"`
}

type ChatResponse struct {
	ID           string `json:"id"`
	Model        string `json:"model"`
	Content      string `json:"content"`
	InputTokens  int    `json:"input_tokens"`
	OutputTokens int    `json:"output_tokens"`
	TotalTokens  int    `json:"total_tokens"`
}

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
	if ctx == nil {
		ctx = context.Background()
	}
	if strings.TrimSpace(c.BaseURL) == "" {
		return ChatResponse{}, errors.New("base URL is required")
	}
	if strings.TrimSpace(c.APIKey) == "" {
		return ChatResponse{}, errors.New("API key is required")
	}
	if strings.TrimSpace(request.Model) == "" {
		return ChatResponse{}, errors.New("model is required")
	}
	if len(request.Messages) == 0 {
		return ChatResponse{}, errors.New("at least one message is required")
	}
	for _, message := range request.Messages {
		if strings.TrimSpace(message.Role) == "" || strings.TrimSpace(message.Content) == "" {
			return ChatResponse{}, errors.New("message role and content are required")
		}
	}

	policy := c.RetryPolicy
	if policy.MaxAttempts == 0 {
		policy = RetryPolicy{MaxAttempts: 1}
	}
	if err := policy.Validate(); err != nil {
		return ChatResponse{}, err
	}
	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}

	var lastErr error
	for attempt := 1; attempt <= policy.MaxAttempts; attempt++ {
		response, retry, err := c.chatOnce(ctx, httpClient, request)
		if err == nil {
			return response, nil
		}
		lastErr = err
		if !retry || attempt == policy.MaxAttempts {
			break
		}
		if policy.Backoff > 0 {
			timer := time.NewTimer(policy.Backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ChatResponse{}, ctx.Err()
			case <-timer.C:
			}
		}
	}
	return ChatResponse{}, lastErr
}

func (c Client) chatOnce(ctx context.Context, httpClient *http.Client, chat ChatRequest) (ChatResponse, bool, error) {
	payload, err := json.Marshal(chat)
	if err != nil {
		return ChatResponse{}, false, err
	}

	endpoint := strings.TrimRight(c.BaseURL, "/") + "/chat/completions"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return ChatResponse{}, false, err
	}
	request.Header.Set("authorization", "Bearer "+c.APIKey)
	request.Header.Set("content-type", "application/json")
	request.Header.Set("accept", "application/json")

	response, err := httpClient.Do(request)
	if err != nil {
		return ChatResponse{}, true, err
	}
	defer response.Body.Close()

	body, readErr := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if readErr != nil {
		return ChatResponse{}, true, readErr
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ChatResponse{}, isRetryableStatus(response.StatusCode), fmt.Errorf("kimi chat failed with status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}

	parsed, err := parseOpenAICompatibleResponse(body)
	if err != nil {
		return ChatResponse{}, false, err
	}
	return parsed, false, nil
}

func parseOpenAICompatibleResponse(body []byte) (ChatResponse, error) {
	var payload struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Message Message `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ChatResponse{}, err
	}
	if len(payload.Choices) == 0 {
		return ChatResponse{}, errors.New("chat response contained no choices")
	}
	content := payload.Choices[0].Message.Content
	if content == "" {
		return ChatResponse{}, errors.New("chat response content is empty")
	}
	return ChatResponse{
		ID:           payload.ID,
		Model:        payload.Model,
		Content:      content,
		InputTokens:  payload.Usage.PromptTokens,
		OutputTokens: payload.Usage.CompletionTokens,
		TotalTokens:  payload.Usage.TotalTokens,
	}, nil
}

func isRetryableStatus(status int) bool {
	return status == http.StatusTooManyRequests || status == http.StatusRequestTimeout || status >= 500
}
