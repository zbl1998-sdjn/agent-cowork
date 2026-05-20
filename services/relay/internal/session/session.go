package session

import "sync"

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
