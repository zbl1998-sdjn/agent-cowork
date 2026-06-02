// api 服务可执行入口(services/api · Go 多服务架构)
// ----------------------------------------------------------------------------
// 职责:启动 HTTP API 网关——读 ADDR(默认 127.0.0.1:8080)并挂载 internal/http 的处理器。
// 说明:这是 v1.0「深水区」多服务后端的 API 单元,与当前 MVP 的 Node host 并行;真正逻辑在 internal/。
package main

import (
	"log"
	"net/http"
	"os"

	httpapi "kimi-cowork/services/api/internal/http"
)

func main() {
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	log.Printf("kimi cowork api listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, httpapi.NewHandler()))
}
