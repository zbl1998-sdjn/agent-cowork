// relay 服务可执行入口(services/relay · Go)——设备会话中继的骨架进程。
// 职责:中继/会话保持的服务入口(当前为骨架);真正会话逻辑在 internal/session。
package main

import "fmt"

func main() {
	fmt.Println("kimi cowork relay skeleton ready")
}
