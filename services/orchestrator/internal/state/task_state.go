package state

import "fmt"

type TaskState string

const (
	Created                TaskState = "created"
	Scoping                TaskState = "scoping"
	Planning               TaskState = "planning"
	AwaitingPlanApproval   TaskState = "awaiting_plan_approval"
	Executing              TaskState = "executing"
	AwaitingToolApproval   TaskState = "awaiting_tool_approval"
	Verifying              TaskState = "verifying"
	Drafting               TaskState = "drafting"
	AwaitingCommitApproval TaskState = "awaiting_commit_approval"
	Committing             TaskState = "committing"
	Completed              TaskState = "completed"
	Failed                 TaskState = "failed"
	Cancelled              TaskState = "cancelled"
	Timeout                TaskState = "timeout"
	PermissionDenied       TaskState = "permission_denied"
	QuotaExceeded          TaskState = "quota_exceeded"
	ModelError             TaskState = "model_error"
	DeviceError            TaskState = "device_error"
)

var transitions = map[TaskState][]TaskState{
	Created:                {Scoping, Cancelled},
	Scoping:                {Planning, Failed, Cancelled},
	Planning:               {AwaitingPlanApproval, Failed, ModelError, Cancelled},
	AwaitingPlanApproval:   {Executing, Cancelled},
	Executing:              {AwaitingToolApproval, Verifying, Failed, DeviceError, Timeout, Cancelled},
	AwaitingToolApproval:   {Executing, PermissionDenied, Cancelled},
	Verifying:              {Drafting, Failed, Cancelled},
	Drafting:               {AwaitingCommitApproval, Completed, Failed, Cancelled},
	AwaitingCommitApproval: {Committing, Cancelled},
	Committing:             {Completed, Failed, DeviceError},
}

func CanTransition(from TaskState, to TaskState) bool {
	for _, candidate := range transitions[from] {
		if candidate == to {
			return true
		}
	}
	return false
}

func Transition(from TaskState, to TaskState) (TaskState, error) {
	if !CanTransition(from, to) {
		return from, fmt.Errorf("invalid task transition: %s -> %s", from, to)
	}
	return to, nil
}
