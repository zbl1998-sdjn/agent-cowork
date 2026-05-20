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
