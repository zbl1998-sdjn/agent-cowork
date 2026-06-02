// Package domain 是 orchestrator 服务的领域核心(services/orchestrator · Go)。
// 职责:定义编排域的实体(BaseEntity 等)、强类型 ID(ids.go)与对外端口接口(ports.go,仓储/总线的
// 抽象,便于依赖倒置与测试)。是六边形架构的「内核」,不依赖具体基础设施。
package domain

import "time"

// BaseEntity 是各领域实体共享的基础字段(ID 与创建/更新时间)。
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
