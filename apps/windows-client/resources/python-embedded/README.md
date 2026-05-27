This directory is the Tauri bundle resource mount for embedded Python.

Do not commit the generated Python payload. `scripts/prepare-embedded-python.ps1`
downloads the pinned official Windows embeddable package, verifies its SHA256,
extracts it here, and writes `PYTHON_EMBEDDED_MANIFEST.json` before Tauri builds.

The installed app wires this resource into the host sidecar through
`KCW_PYTHON_HOME` and `KCW_EMBEDDED_PYTHON`.
