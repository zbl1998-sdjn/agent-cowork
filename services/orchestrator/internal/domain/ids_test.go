package domain

import "testing"

func TestNewIDProducesSortableULIDShape(t *testing.T) {
	first := MustNewID()
	second := MustNewID()
	if err := ValidateID(first); err != nil {
		t.Fatal(err)
	}
	if err := ValidateID(second); err != nil {
		t.Fatal(err)
	}
	if len(first) != 26 || len(second) != 26 {
		t.Fatalf("unexpected id length: %q %q", first, second)
	}
}

func TestBaseEntityCarriesScaleFields(t *testing.T) {
	tenantID := MustNewID()
	userID := MustNewID()
	base := NewBaseEntity(tenantID, userID, "trace-test")
	if base.TenantID != tenantID || base.UserID != userID || base.TraceID != "trace-test" {
		t.Fatalf("missing tenant/user/trace fields: %#v", base)
	}
	if base.Version != 1 {
		t.Fatalf("unexpected version: %d", base.Version)
	}
}
