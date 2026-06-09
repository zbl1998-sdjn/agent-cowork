package state

import "testing"

// 状态机应允许按定义的正常路径推进,保证编排器可以逐步进入 scoping 阶段。
func TestTransitionAllowsHappyPath(t *testing.T) {
	next, err := Transition(Created, Scoping)
	if err != nil {
		t.Fatal(err)
	}
	if next != Scoping {
		t.Fatalf("unexpected state: %s", next)
	}
}

// 状态机必须拒绝跳过中间阶段的跃迁,避免任务绕过必要审批或执行前置条件。
func TestTransitionRejectsInvalidJump(t *testing.T) {
	if _, err := Transition(Created, Completed); err == nil {
		t.Fatal("expected invalid jump to be rejected")
	}
}
