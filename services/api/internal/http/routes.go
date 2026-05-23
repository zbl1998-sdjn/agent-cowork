package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

type contextKey string

const requestContextKey contextKey = "agent-cowork-request-context"

type RequestContext struct {
	TraceID        string `json:"trace_id"`
	TenantID       string `json:"tenant_id"`
	UserID         string `json:"user_id"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
}

func NewHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "agent-cowork-api"})
	})
	mux.HandleFunc("POST /v1/devices", accepted("device_registered"))
	mux.HandleFunc("POST /v1/workspaces", accepted("workspace_registered"))
	mux.HandleFunc("GET /v1/workspaces", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"workspaces": []any{}})
	})
	mux.HandleFunc("POST /v1/tasks", accepted("task_created"))
	return requestContextMiddleware(mux)
}

func accepted(status string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusAccepted, map[string]any{"status": status, "context": requestContext(r)})
	}
}

func requestContext(r *http.Request) RequestContext {
	if ctx, ok := r.Context().Value(requestContextKey).(RequestContext); ok {
		return ctx
	}
	return RequestContext{}
}

func requestContextMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := RequestContext{
			TraceID:        cleanHeader(r.Header.Get("x-trace-id"), "trace_"+randomHex(16)),
			TenantID:       cleanHeader(r.Header.Get("x-tenant-id"), "tenant_local"),
			UserID:         cleanHeader(r.Header.Get("x-user-id"), "user_local"),
			IdempotencyKey: cleanHeader(r.Header.Get("idempotency-key"), ""),
		}
		w.Header().Set("x-trace-id", ctx.TraceID)
		w.Header().Set("x-tenant-id", ctx.TenantID)
		w.Header().Set("x-user-id", ctx.UserID)
		if strings.HasPrefix(r.URL.Path, "/v1/") && r.Method == http.MethodPost && ctx.IdempotencyKey == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Idempotency-Key header is required", "context": ctx})
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestContextKey, ctx)))
	})
}

func cleanHeader(value string, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 96 {
		return fallback
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') && r != '_' && r != '-' && r != '.' && r != ':' {
			return fallback
		}
	}
	return value
}

func randomHex(bytes int) string {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return "fallback"
	}
	return fmt.Sprintf("%x", buf)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
