package kimi

import "errors"

// Budget 是单次请求的 token 预算(输入/输出上限);Validate 校验其为正。防止失控消耗。
type Budget struct {
	MaxInputTokens  int
	MaxOutputTokens int
}

func (b Budget) Validate() error {
	if b.MaxInputTokens <= 0 {
		return errors.New("max input tokens must be positive")
	}
	if b.MaxOutputTokens <= 0 {
		return errors.New("max output tokens must be positive")
	}
	return nil
}
