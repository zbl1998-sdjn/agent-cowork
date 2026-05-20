package kimi

import (
	"net/http"
	"time"
)

type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

func NewClient(baseURL string, apiKey string, timeout time.Duration) Client {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return Client{
		BaseURL: baseURL,
		APIKey:  apiKey,
		HTTPClient: &http.Client{
			Timeout: timeout,
		},
	}
}
