package kimi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Client struct {
	BaseURL     string
	BaseURLs    []string
	APIKey      string
	APIKeys     []string
	HTTPClient  *http.Client
	RetryPolicy RetryPolicy
	Breaker     *CircuitBreaker
}

type Message struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

type ImageURL struct {
	URL    string `json:"url"`
	Detail string `json:"detail,omitempty"`
}

type ContentPart struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	ImageURL *ImageURL `json:"image_url,omitempty"`
}

type ToolFunction struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Parameters  any    `json:"parameters,omitempty"`
}

type Tool struct {
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

type ToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ToolCall struct {
	ID       string           `json:"id"`
	Type     string           `json:"type"`
	Function ToolCallFunction `json:"function"`
}

type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	TotalTokens  int `json:"total_tokens"`
}

type ChatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	MaxTokens   int       `json:"max_tokens,omitempty"`
	Temperature *float64  `json:"temperature,omitempty"`
	Tools       []Tool    `json:"tools,omitempty"`
	ToolChoice  any       `json:"tool_choice,omitempty"`
	Stream      bool      `json:"stream,omitempty"`
}

type ChatResponse struct {
	ID           string     `json:"id"`
	Model        string     `json:"model"`
	Content      string     `json:"content"`
	ToolCalls    []ToolCall `json:"tool_calls,omitempty"`
	InputTokens  int        `json:"input_tokens"`
	OutputTokens int        `json:"output_tokens"`
	TotalTokens  int        `json:"total_tokens"`
}

type StreamEvent struct {
	Type         string    `json:"type"`
	ID           string    `json:"id,omitempty"`
	Model        string    `json:"model,omitempty"`
	ContentDelta string    `json:"content_delta,omitempty"`
	ToolCall     *ToolCall `json:"tool_call,omitempty"`
	Usage        *Usage    `json:"usage,omitempty"`
	Done         bool      `json:"done,omitempty"`
}

const (
	StreamEventDelta    = "delta"
	StreamEventToolCall = "tool_call"
	StreamEventUsage    = "llm.usage"
	StreamEventDone     = "done"
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

	var lastErr error
	for attempt := 1; attempt <= policy.MaxAttempts; attempt++ {
		baseURL, apiKey, err := c.endpointForAttempt(attempt)
		if err != nil {
			return ChatResponse{}, err
		}
		if !c.breakerAllows() {
			return ChatResponse{}, errors.New("kimi circuit breaker is open")
		}
		response, retry, err := c.chatOnce(ctx, httpClient, request, baseURL, apiKey)
		if err == nil {
			c.recordBreakerSuccess()
			return response, nil
		}
		lastErr = err
		if retry {
			c.recordBreakerFailure()
		}
		if !retry || attempt == policy.MaxAttempts {
			break
		}
		if err := waitBackoff(ctx, policy.Backoff); err != nil {
			return ChatResponse{}, err
		}
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

	var lastErr error
	for attempt := 1; attempt <= policy.MaxAttempts; attempt++ {
		baseURL, apiKey, err := c.endpointForAttempt(attempt)
		if err != nil {
			return err
		}
		if !c.breakerAllows() {
			return errors.New("kimi circuit breaker is open")
		}
		retry, err := c.streamOnce(ctx, httpClient, request, baseURL, apiKey, emit)
		if err == nil {
			c.recordBreakerSuccess()
			return nil
		}
		lastErr = err
		if retry {
			c.recordBreakerFailure()
		}
		if !retry || attempt == policy.MaxAttempts {
			break
		}
		if err := waitBackoff(ctx, policy.Backoff); err != nil {
			return err
		}
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
		if err := emitStreamPayload(data, emit); err != nil {
			return false, err
		}
	}
	if err := scanner.Err(); err != nil {
		return true, err
	}
	return false, emit(StreamEvent{Type: StreamEventDone, Done: true})
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
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		return nil, isRetryableStatus(response.StatusCode), fmt.Errorf("kimi chat failed with status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
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

func parseOpenAICompatibleResponse(body []byte) (ChatResponse, error) {
	var payload struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content   any        `json:"content"`
				ToolCalls []ToolCall `json:"tool_calls"`
			} `json:"message"`
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
	content := messageText(payload.Choices[0].Message.Content)
	toolCalls := payload.Choices[0].Message.ToolCalls
	if content == "" && len(toolCalls) == 0 {
		return ChatResponse{}, errors.New("chat response content is empty")
	}
	return ChatResponse{
		ID:           payload.ID,
		Model:        payload.Model,
		Content:      content,
		ToolCalls:    toolCalls,
		InputTokens:  payload.Usage.PromptTokens,
		OutputTokens: payload.Usage.CompletionTokens,
		TotalTokens:  payload.Usage.TotalTokens,
	}, nil
}

func emitStreamPayload(data string, emit func(StreamEvent) error) error {
	var payload struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Delta struct {
				Content   string     `json:"content"`
				ToolCalls []ToolCall `json:"tool_calls"`
			} `json:"delta"`
		} `json:"choices"`
		Usage *struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal([]byte(data), &payload); err != nil {
		return err
	}
	if payload.Usage != nil {
		if err := emit(StreamEvent{
			Type:  StreamEventUsage,
			ID:    payload.ID,
			Model: payload.Model,
			Usage: &Usage{
				InputTokens:  payload.Usage.PromptTokens,
				OutputTokens: payload.Usage.CompletionTokens,
				TotalTokens:  payload.Usage.TotalTokens,
			},
		}); err != nil {
			return err
		}
	}
	for _, choice := range payload.Choices {
		if choice.Delta.Content != "" {
			if err := emit(StreamEvent{Type: StreamEventDelta, ID: payload.ID, Model: payload.Model, ContentDelta: choice.Delta.Content}); err != nil {
				return err
			}
		}
		for i := range choice.Delta.ToolCalls {
			call := choice.Delta.ToolCalls[i]
			if err := emit(StreamEvent{Type: StreamEventToolCall, ID: payload.ID, Model: payload.Model, ToolCall: &call}); err != nil {
				return err
			}
		}
	}
	return nil
}

func hasMessageContent(content any) bool {
	switch value := content.(type) {
	case string:
		return strings.TrimSpace(value) != ""
	case []ContentPart:
		return len(value) > 0
	case []any:
		return len(value) > 0
	case nil:
		return false
	default:
		return true
	}
}

func messageText(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []ContentPart:
		var parts []string
		for _, part := range value {
			if part.Type == "text" && part.Text != "" {
				parts = append(parts, part.Text)
			}
		}
		return strings.Join(parts, "\n")
	case []any:
		var parts []string
		for _, item := range value {
			if part, ok := item.(map[string]any); ok && part["type"] == "text" {
				if text, ok := part["text"].(string); ok && text != "" {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

type StreamHandler struct {
	Client Client
}

func NewStreamHandler(client Client) http.Handler {
	return StreamHandler{Client: client}
}

func (h StreamHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/chat/stream" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	request, err := decodeChatRequest(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	w.Header().Set("content-type", "text/event-stream; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	emit := func(event StreamEvent) error {
		if err := writeSSE(w, eventName(event), event); err != nil {
			return err
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	}
	if err := h.Client.ChatStream(r.Context(), request, emit); err != nil {
		_ = writeSSE(w, "error", map[string]string{"error": err.Error()})
		if flusher != nil {
			flusher.Flush()
		}
	}
}

func decodeChatRequest(r *http.Request) (ChatRequest, error) {
	contentType := strings.ToLower(r.Header.Get("content-type"))
	if strings.HasPrefix(contentType, "multipart/form-data") {
		return decodeMultipartChatRequest(r)
	}
	var request ChatRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&request); err != nil {
		return ChatRequest{}, err
	}
	return request, nil
}

func decodeMultipartChatRequest(r *http.Request) (ChatRequest, error) {
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		return ChatRequest{}, err
	}
	request := ChatRequest{
		Model:     r.FormValue("model"),
		MaxTokens: parseIntField(r.FormValue("max_tokens")),
	}
	if raw := r.FormValue("messages"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &request.Messages); err != nil {
			return ChatRequest{}, err
		}
	} else {
		prompt := strings.TrimSpace(r.FormValue("prompt"))
		imageURL := strings.TrimSpace(r.FormValue("image_url"))
		parts := make([]ContentPart, 0, 2)
		if prompt != "" {
			parts = append(parts, ContentPart{Type: "text", Text: prompt})
		}
		if imageURL != "" {
			parts = append(parts, ContentPart{Type: "image_url", ImageURL: &ImageURL{URL: imageURL}})
		}
		request.Messages = []Message{{Role: "user", Content: parts}}
	}
	if raw := r.FormValue("tools"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &request.Tools); err != nil {
			return ChatRequest{}, err
		}
	}
	return request, nil
}

func parseIntField(value string) int {
	if strings.TrimSpace(value) == "" {
		return 0
	}
	parsed, _ := strconv.Atoi(value)
	return parsed
}

func writeSSE(w io.Writer, event string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", body); err != nil {
		return err
	}
	return nil
}

func eventName(event StreamEvent) string {
	if event.Type == "" {
		return StreamEventDelta
	}
	return event.Type
}

func AddMultipartField(w *multipart.Writer, name string, value string) error {
	field, err := w.CreateFormField(name)
	if err != nil {
		return err
	}
	_, err = field.Write([]byte(value))
	return err
}

func isRetryableStatus(status int) bool {
	return status == http.StatusTooManyRequests || status == http.StatusRequestTimeout || status >= 500
}
