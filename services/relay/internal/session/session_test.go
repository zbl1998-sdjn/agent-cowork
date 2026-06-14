package session

import "testing"

// relay 会话注册表要能按设备 ID 找回租户/用户上下文,这是设备通道隔离的最小契约。
func TestRegistryStoresDeviceSession(t *testing.T) {
	registry := NewRegistry()
	registry.Put(DeviceSession{DeviceID: "dev1", TenantID: "tenant1", UserID: "user1"})
	got, ok := registry.Get("dev1")
	if !ok {
		t.Fatal("expected session")
	}
	if got.TenantID != "tenant1" {
		t.Fatalf("unexpected session: %#v", got)
	}
}
