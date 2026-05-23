package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealth(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	NewHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["service"] != "agent-cowork-api" {
		t.Fatalf("unexpected body: %#v", body)
	}
	if rec.Header().Get("x-trace-id") == "" {
		t.Fatal("expected trace header")
	}
}

func TestV1PostRequiresIdempotencyKey(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/tasks", nil)
	rec := httptest.NewRecorder()
	NewHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
}

func TestV1PostCarriesScaleContext(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/tasks", nil)
	req.Header.Set("idempotency-key", "idem-1")
	req.Header.Set("x-tenant-id", "tenant_1")
	req.Header.Set("x-user-id", "user_1")
	req.Header.Set("x-trace-id", "trace_1")
	rec := httptest.NewRecorder()
	NewHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	contextBody := body["context"].(map[string]any)
	if contextBody["tenant_id"] != "tenant_1" || contextBody["user_id"] != "user_1" || contextBody["trace_id"] != "trace_1" {
		t.Fatalf("unexpected context: %#v", contextBody)
	}
}
