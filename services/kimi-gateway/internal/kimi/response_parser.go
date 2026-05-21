package kimi

import (
	"encoding/json"
	"errors"
	"strings"
)

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
		for _, part := range value {
			if contentPartHasContent(part) {
				return true
			}
		}
		return false
	case []any:
		for _, item := range value {
			if contentMapHasContent(item) {
				return true
			}
		}
		return false
	case nil:
		return false
	default:
		return true
	}
}

func contentPartHasContent(part ContentPart) bool {
	switch part.Type {
	case "text":
		return strings.TrimSpace(part.Text) != ""
	case "image_url":
		return part.ImageURL != nil && strings.TrimSpace(part.ImageURL.URL) != ""
	default:
		return false
	}
}

func contentMapHasContent(item any) bool {
	part, ok := item.(map[string]any)
	if !ok {
		return false
	}
	partType, _ := part["type"].(string)
	switch partType {
	case "text":
		text, _ := part["text"].(string)
		return strings.TrimSpace(text) != ""
	case "image_url":
		switch imageURL := part["image_url"].(type) {
		case map[string]any:
			url, _ := imageURL["url"].(string)
			return strings.TrimSpace(url) != ""
		case string:
			return strings.TrimSpace(imageURL) != ""
		default:
			return false
		}
	default:
		return false
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
