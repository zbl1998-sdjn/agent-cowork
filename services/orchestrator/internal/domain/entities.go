package domain

import "time"

type BaseEntity struct {
	ID        ID
	TenantID  ID
	UserID    ID
	TraceID   string
	CreatedAt time.Time
	UpdatedAt time.Time
	Version   int64
}

func NewBaseEntity(tenantID, userID ID, traceID string) BaseEntity {
	now := time.Now().UTC()
	return BaseEntity{
		ID:        MustNewID(),
		TenantID:  tenantID,
		UserID:    userID,
		TraceID:   traceID,
		CreatedAt: now,
		UpdatedAt: now,
		Version:   1,
	}
}

type Workspace struct {
	BaseEntity
	Name   string
	BlobID ID
}

type Recipe struct {
	BaseEntity
	Name        string
	Description string
}

type Run struct {
	BaseEntity
	WorkspaceID ID
	RecipeID    ID
	Status      string
}

type Artifact struct {
	BaseEntity
	RunID  ID
	BlobID ID
	Kind   string
}

type AuditEvent struct {
	BaseEntity
	Topic   string
	Payload []byte
}

type Schedule struct {
	BaseEntity
	RecipeID ID
	Cron     string
	Enabled  bool
}

type MemoryFact struct {
	BaseEntity
	Scope string
	Fact  string
}
