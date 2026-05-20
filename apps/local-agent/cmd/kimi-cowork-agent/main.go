package main

import (
	"flag"
	"fmt"
	"os"
)

const version = "0.1.0-v0.3"

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	fmt.Fprintln(os.Stdout, "kimi-cowork-agent skeleton ready")
}
