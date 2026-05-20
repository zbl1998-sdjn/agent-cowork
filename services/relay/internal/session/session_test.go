package session

import "testing"

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
