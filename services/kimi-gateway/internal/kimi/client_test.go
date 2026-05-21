package kimi

import (
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientChatSendsOpenAICompatibleRequest(t *testing.T) {
	var seenAuth string
	var seenPath string
	var seenBody struct {
		Model    string    `json:"model"`
		Messages []Message `json:"messages"`
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("authorization")
		seenPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&seenBody); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"chatcmpl-test",
			"model":"kimi-k2",
			"choices":[{"message":{"role":"assistant","content":"整理完成"}}],
			"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}
		}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key", time.Second)
	client.RetryPolicy = RetryPolicy{MaxAttempts: 1}

	response, err := client.Chat(context.Background(), ChatRequest{
		Model: "kimi-k2",
		Messages: []Message{
			{Role: "system", Content: "你是 Kimi Cowork"},
			{Role: "user", Content: "整理文件夹"},
		},
		MaxTokens: 128,
	})
	if err != nil {
		t.Fatal(err)
	}

	if seenPath != "/chat/completions" {
		t.Fatalf("unexpected path: %s", seenPath)
	}
	if seenAuth != "Bearer test-key" {
		t.Fatalf("unexpected auth header: %s", seenAuth)
	}
	if seenBody.Model != "kimi-k2" || len(seenBody.Messages) != 2 {
		t.Fatalf("unexpected request body: %+v", seenBody)
	}
	if response.Content != "整理完成" || response.TotalTokens != 18 {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestClientChatRetries429(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key", time.Second)
	client.RetryPolicy = RetryPolicy{MaxAttempts: 2, Backoff: 0}

	response, err := client.Chat(context.Background(), ChatRequest{
		Model:    "kimi-k2",
		Messages: []Message{{Role: "user", Content: "ping"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.Content != "ok" {
		t.Fatalf("unexpected content: %s", response.Content)
	}
	if attempts != 2 {
		t.Fatalf("expected 2 attempts, got %d", attempts)
	}
}

func TestClientChatDoesNotRetry400(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		http.Error(w, "bad request", http.StatusBadRequest)
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key", time.Second)
	client.RetryPolicy = RetryPolicy{MaxAttempts: 3, Backoff: 0}

	_, err := client.Chat(context.Background(), ChatRequest{
		Model:    "kimi-k2",
		Messages: []Message{{Role: "user", Content: "ping"}},
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if attempts != 1 {
		t.Fatalf("expected 1 attempt, got %d", attempts)
	}
	if !strings.Contains(err.Error(), "status 400") {
		t.Fatalf("expected status in error, got %v", err)
	}
}

func TestClientChatValidatesInputs(t *testing.T) {
	client := NewClient("http://127.0.0.1", "key", time.Second)
	if _, err := client.Chat(context.Background(), ChatRequest{Messages: []Message{{Role: "user", Content: "hi"}}}); err == nil {
		t.Fatal("expected missing model to fail")
	}
	if _, err := client.Chat(context.Background(), ChatRequest{Model: "kimi-k2"}); err == nil {
		t.Fatal("expected missing messages to fail")
	}

	client = NewClient("http://127.0.0.1", "", time.Second)
	if _, err := client.Chat(context.Background(), ChatRequest{Model: "kimi-k2", Messages: []Message{{Role: "user", Content: "hi"}}}); err == nil {
		t.Fatal("expected missing API key to fail")
	}
}

func TestClientChatForwardsToolsAndParsesToolCalls(t *testing.T) {
	var seenBody struct {
		Tools []Tool `json:"tools"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&seenBody); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		_, _ = w.Write([]byte(`{
			"id":"chatcmpl-tool",
			"model":"kimi-k2",
			"choices":[{
				"message":{
					"role":"assistant",
					"content":"",
					"tool_calls":[{
						"id":"call_1",
						"type":"function",
						"function":{"name":"write_file","arguments":"{\"path\":\"a.txt\"}"}
					}]
				}
			}]
		}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key", time.Second)
	client.RetryPolicy = RetryPolicy{MaxAttempts: 1}
	response, err := client.Chat(context.Background(), ChatRequest{
		Model:    "kimi-k2",
		Messages: []Message{{Role: "user", Content: "生成文件"}},
		Tools: []Tool{{
			Type: "function",
			Function: ToolFunction{
				Name:        "write_file",
				Description: "write a local file",
				Parameters:  map[string]any{"type": "object"},
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(seenBody.Tools) != 1 || seenBody.Tools[0].Function.Name != "write_file" {
		t.Fatalf("tools were not forwarded: %+v", seenBody.Tools)
	}
	if len(response.ToolCalls) != 1 || response.ToolCalls[0].Function.Name != "write_file" {
		t.Fatalf("tool calls were not parsed: %+v", response.ToolCalls)
	}
}

func TestClientChatStreamParsesDeltasToolCallsUsageAndDone(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("accept") != "text/event-stream" {
			t.Fatalf("unexpected accept header: %s", r.Header.Get("accept"))
		}
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"id\":\"s1\",\"model\":\"kimi-k2\",\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"id\":\"s1\",\"model\":\"kimi-k2\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"id\":\"s1\",\"model\":\"kimi-k2\",\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key", time.Second)
	client.RetryPolicy = RetryPolicy{MaxAttempts: 1}
	var events []StreamEvent
	err := client.ChatStream(context.Background(), ChatRequest{
		Model:    "kimi-k2",
		Messages: []Message{{Role: "user", Content: "ping"}},
	}, func(event StreamEvent) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 4 {
		t.Fatalf("expected 4 events, got %+v", events)
	}
	if events[0].Type != StreamEventDelta || events[0].ContentDelta != "hel" {
		t.Fatalf("unexpected delta event: %+v", events[0])
	}
	if events[1].Type != StreamEventToolCall || events[1].ToolCall.Function.Name != "lookup" {
		t.Fatalf("unexpected tool event: %+v", events[1])
	}
	if events[2].Type != StreamEventUsage || events[2].Usage.TotalTokens != 5 {
		t.Fatalf("unexpected usage event: %+v", events[2])
	}
	if events[3].Type != StreamEventDone || !events[3].Done {
		t.Fatalf("unexpected done event: %+v", events[3])
	}
}

func TestClientRotatesKeysAndFallsBackBaseURLs(t *testing.T) {
	var seenAuth []string
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = append(seenAuth, r.Header.Get("authorization"))
		http.Error(w, "temporary", http.StatusServiceUnavailable)
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = append(seenAuth, r.Header.Get("authorization"))
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer second.Close()

	client := NewClient(first.URL, "key-a", time.Second)
	client.BaseURLs = []string{second.URL}
	client.APIKeys = []string{"key-b"}
	client.RetryPolicy = RetryPolicy{MaxAttempts: 2, Backoff: 0}
	response, err := client.Chat(context.Background(), ChatRequest{
		Model:    "kimi-k2",
		Messages: []Message{{Role: "user", Content: "ping"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.Content != "ok" {
		t.Fatalf("unexpected response: %+v", response)
	}
	if len(seenAuth) != 2 || seenAuth[0] != "Bearer key-a" || seenAuth[1] != "Bearer key-b" {
		t.Fatalf("unexpected key rotation: %+v", seenAuth)
	}
}

func TestCircuitBreakerOpensAfterRetryableFailure(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		http.Error(w, "temporary", http.StatusServiceUnavailable)
	}))
	defer server.Close()

	breaker := &CircuitBreaker{MaxFailures: 1, Cooldown: time.Minute}
	client := NewClient(server.URL, "test-key", time.Second)
	client.RetryPolicy = RetryPolicy{MaxAttempts: 1}
	client.Breaker = breaker

	_, err := client.Chat(context.Background(), ChatRequest{
		Model:    "kimi-k2",
		Messages: []Message{{Role: "user", Content: "ping"}},
	})
	if err == nil {
		t.Fatal("expected first call to fail")
	}
	_, err = client.Chat(context.Background(), ChatRequest{
		Model:    "kimi-k2",
		Messages: []Message{{Role: "user", Content: "ping"}},
	})
	if err == nil || !strings.Contains(err.Error(), "circuit breaker") {
		t.Fatalf("expected open circuit breaker, got %v", err)
	}
	if attempts != 1 {
		t.Fatalf("expected breaker to stop second request, got %d attempts", attempts)
	}
}

func TestStreamHandlerAcceptsMultipartVisionAndEmitsSSE(t *testing.T) {
	var seen struct {
		Messages []Message `json:"messages"`
		Stream   bool      `json:"stream"`
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&seen); err != nil {
			t.Fatalf("decode upstream body: %v", err)
		}
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"id\":\"s1\",\"model\":\"kimi-k2\",\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"id\":\"s1\",\"model\":\"kimi-k2\",\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer upstream.Close()

	client := NewClient(upstream.URL, "test-key", time.Second)
	client.RetryPolicy = RetryPolicy{MaxAttempts: 1}
	handler := NewStreamHandler(client)

	var body strings.Builder
	writer := multipart.NewWriter(&body)
	if err := AddMultipartField(writer, "model", "kimi-k2"); err != nil {
		t.Fatal(err)
	}
	if err := AddMultipartField(writer, "prompt", "看图总结"); err != nil {
		t.Fatal(err)
	}
	if err := AddMultipartField(writer, "image_url", "data:image/png;base64,AAAA"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "/v1/chat/stream", strings.NewReader(body.String()))
	request.Header.Set("content-type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "event: llm.usage") {
		t.Fatalf("usage event missing: %s", response.Body.String())
	}
	if !seen.Stream {
		t.Fatal("upstream request did not enable stream")
	}
	parts, ok := seen.Messages[0].Content.([]any)
	if !ok || len(parts) != 2 {
		t.Fatalf("expected text + image_url content parts, got %#v", seen.Messages[0].Content)
	}
}
