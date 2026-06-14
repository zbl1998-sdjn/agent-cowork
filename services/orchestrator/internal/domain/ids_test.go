package domain

import "testing"

// 领域 ID 使用固定 26 位 ULID 形状,保证未来按字符串排序时仍具备时间局部性。
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

// BaseEntity 必须携带租户、用户、trace 与版本字段,这是多租户审计和乐观演进的基础。
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
