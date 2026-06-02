package kimi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
)

const (
	maxJSONRequestBytes      = 2 << 20
	maxMultipartRequestBytes = 16 << 20
)

// StreamHandler 是 kimi-gateway 的 HTTP 入口:接收对话请求(JSON 或 multipart),以 SSE 把模型流式输出转发给调用方。
type StreamHandler struct {
	Client Client
}

// NewStreamHandler 用给定 Client 构造流式 HTTP 处理器。
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
	requestLimit := int64(maxJSONRequestBytes)
	if strings.HasPrefix(strings.ToLower(r.Header.Get("content-type")), "multipart/form-data") {
		requestLimit = maxMultipartRequestBytes
	}
	r.Body = http.MaxBytesReader(w, r.Body, requestLimit)
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
	if err := json.NewDecoder(io.LimitReader(r.Body, maxJSONRequestBytes)).Decode(&request); err != nil {
		return ChatRequest{}, err
	}
	return request, nil
}

func decodeMultipartChatRequest(r *http.Request) (ChatRequest, error) {
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		return ChatRequest{}, err
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	request := ChatRequest{
		Model: r.FormValue("model"),
	}
	maxTokens, err := parseIntField(r.FormValue("max_tokens"))
	if err != nil {
		return ChatRequest{}, err
	}
	request.MaxTokens = maxTokens
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
		if len(parts) == 0 {
			return ChatRequest{}, errors.New("prompt or image_url is required")
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

func parseIntField(value string) (int, error) {
	if strings.TrimSpace(value) == "" {
		return 0, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return 0, errors.New("max_tokens must be a non-negative integer")
	}
	return parsed, nil
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

// AddMultipartField 向 multipart 写入器追加一个文本字段(构造 multipart 请求体的辅助)。
func AddMultipartField(w *multipart.Writer, name string, value string) error {
	field, err := w.CreateFormField(name)
	if err != nil {
		return err
	}
	_, err = field.Write([]byte(value))
	return err
}
