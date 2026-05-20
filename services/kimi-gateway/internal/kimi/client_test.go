package kimi

import (
	"context"
	"encoding/json"
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
