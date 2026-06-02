// Package session 管理 relay 服务的设备会话(services/relay · Go)。
// 职责:并发安全地登记/查询/移除按设备的会话状态,为后续中继转发提供会话上下文。
package session

import "sync"

// DeviceSession 表示单个设备的会话状态。
type DeviceSession struct {
	DeviceID string
	TenantID string
	UserID   string
}

type Registry struct {
	mu       sync.RWMutex
	sessions map[string]DeviceSession
}

func NewRegistry() *Registry {
	return &Registry{sessions: map[string]DeviceSession{}}
}

func (r *Registry) Put(session DeviceSession) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessions[session.DeviceID] = session
}

func (r *Registry) Get(deviceID string) (DeviceSession, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	session, ok := r.sessions[deviceID]
	return session, ok
}

func (r *Registry) Delete(deviceID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, deviceID)
}
