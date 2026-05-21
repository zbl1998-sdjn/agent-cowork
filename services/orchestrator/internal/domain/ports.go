package domain

import "context"

type Query struct {
	TenantID ID
	Limit    int
	Cursor   string
}

type Repository[T any] interface {
	Save(context.Context, T) error
	Find(context.Context, ID) (T, error)
	Query(context.Context, Query) ([]T, error)
	Stream(context.Context, Query) (<-chan T, error)
}

type LLMRequest struct {
	TenantID       ID
	UserID         ID
	TraceID        string
	IdempotencyKey string
	Priority       string
	BudgetTokens   int
	Prompt         string
}

type LLMResponse struct {
	Text       string
	InputTok   int
	OutputTok  int
	ProviderID string
}

type LLMChunk struct {
	Text  string
	Final bool
}

type LLMClient interface {
	Chat(context.Context, LLMRequest) (LLMResponse, error)
	Stream(context.Context, LLMRequest) (<-chan LLMChunk, error)
}

type SandboxSpec struct {
	TenantID ID
	TraceID  string
	Command  string
	Args     []string
	Env      map[string]string
}

type SandboxResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

type SandboxPort interface {
	Exec(context.Context, SandboxSpec) (SandboxResult, error)
}

type BlobStore interface {
	Put(context.Context, []byte) (ID, error)
	Get(context.Context, ID) ([]byte, error)
	Sign(context.Context, ID) (string, error)
}

type Event struct {
	ID       ID
	TenantID ID
	TraceID  string
	Topic    string
	Payload  []byte
}

type EventBus interface {
	Publish(context.Context, string, Event) error
	Subscribe(context.Context, string, func(context.Context, Event) error) error
}

type Job struct {
	ID       ID
	TenantID ID
	TraceID  string
	Type     string
	Payload  []byte
}

type JobQueue interface {
	Enqueue(context.Context, Job) error
	Process(context.Context, func(context.Context, Job) error) error
}
