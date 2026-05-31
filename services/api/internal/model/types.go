// Package model 定义 api 服务的核心领域类型与强类型 ID(services/api · Go)。
// 职责:Workspace/Task 等实体及 TenantID/UserID/DeviceID/WorkspaceID/TaskID 等 ID 类型,作为各层共享的数据契约。
package model

import "time"

type TenantID string
type UserID string
type DeviceID string
type WorkspaceID string
type TaskID string

// Workspace 表示一个已登记的可信工作区(归属某租户/用户/设备,带信任状态)。
type Workspace struct {
	ID         WorkspaceID `json:"id"`
	TenantID   TenantID    `json:"tenant_id"`
	UserID     UserID      `json:"user_id"`
	DeviceID   DeviceID    `json:"device_id"`
	PathAlias  string      `json:"path_alias"`
	TrustState string      `json:"trust_state"`
	CreatedAt  time.Time   `json:"created_at"`
	UpdatedAt  time.Time   `json:"updated_at"`
}

// Task 表示一次 Agent 任务(目标、状态、模式,关联工作区与归属)。
type Task struct {
	ID          TaskID      `json:"id"`
	TenantID    TenantID    `json:"tenant_id"`
	UserID      UserID      `json:"user_id"`
	DeviceID    DeviceID    `json:"device_id"`
	WorkspaceID WorkspaceID `json:"workspace_id"`
	UserGoal    string      `json:"user_goal"`
	Status      string      `json:"status"`
	Mode        string      `json:"mode"`
	CreatedAt   time.Time   `json:"created_at"`
	UpdatedAt   time.Time   `json:"updated_at"`
}
