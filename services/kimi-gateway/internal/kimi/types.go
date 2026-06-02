// Package kimi 是 kimi-gateway 服务的核心:对上游 Kimi/大模型 API 的健壮客户端(services/kimi-gateway · Go)。
// 职责:聊天(含流式)请求、多 BaseURL/多 Key 轮换、重试退避、熔断保护、预算校验、响应/流解析。
// 文件分工:types(数据契约)、client(客户端主体)、client_helpers(辅助)、response_parser(响应解析)、
// stream_handler(SSE 流处理)、breaker(熔断)、retry(重试策略)、budget(预算)。
package kimi

import "net/http"

// Client 是带韧性的 Kimi API 客户端:支持多 BaseURL/多 APIKey 轮换、重试策略与熔断器。
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

// ChatRequest / ChatResponse / StreamEvent 是与上游对话的请求、聚合响应与流式事件契约。
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
