package state

import "testing"

func TestTransitionAllowsHappyPath(t *testing.T) {
	next, err := Transition(Created, Scoping)
	if err != nil {
		t.Fatal(err)
	}
	if next != Scoping {
		t.Fatalf("unexpected state: %s", next)
	}
}

func TestTransitionRejectsInvalidJump(t *testing.T) {
	if _, err := Transition(Created, Completed); err == nil {
		t.Fatal("expected invalid jump to be rejected")
	}
}
