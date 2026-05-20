package model

import "time"

type TenantID string
type UserID string
type DeviceID string
type WorkspaceID string
type TaskID string

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
