package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// ModoEjecucion define cómo se schedulean las goroutines.
type ModoEjecucion string

const (
	ModoCooperativo  ModoEjecucion = "cooperativo"  // GOMAXPROCS=1, asyncpreemptoff=1
	ModoConcurrente  ModoEjecucion = "concurrente"  // GOMAXPROCS=1, asyncpreemptoff=0
	ModoParalelo     ModoEjecucion = "paralelo"     // GOMAXPROCS=runtime.NumCPU()
)

// CompileAndRun compila el código Go a un binario nativo, lo ejecuta con el
// modo de ejecución indicado y streamea cada línea de stdout al writer w.
func CompileAndRun(code string, w io.Writer, modo ModoEjecucion) error {
	tmpDir, err := os.MkdirTemp("", "goconcu-*")
	if err != nil {
		return fmt.Errorf("no se pudo crear directorio temporal: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	srcPath := filepath.Join(tmpDir, "main.go")
	if err := os.WriteFile(srcPath, []byte(code), 0644); err != nil {
		return fmt.Errorf("no se pudo escribir el archivo fuente: %w", err)
	}

	modInit := exec.Command("go", "mod", "init", "playground")
	modInit.Dir = tmpDir
	if out, err := modInit.CombinedOutput(); err != nil {
		return fmt.Errorf("go mod init falló: %w\n%s", err, out)
	}

	binPath := filepath.Join(tmpDir, "main.exe")
	cmd := exec.Command("go", "build", "-o", binPath, ".")
	cmd.Dir = tmpDir
	cmd.Env = os.Environ()

	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s", out)
	}

	// Configurar variables de entorno según el modo
	env := os.Environ()
	switch modo {
	case ModoCooperativo:
		env = append(env, "GOMAXPROCS=1", "GODEBUG=asyncpreemptoff=1")
	case ModoConcurrente:
		env = append(env, "GOMAXPROCS=1")
	// ModoParalelo: usa los defaults del sistema (todos los cores)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	run := exec.CommandContext(ctx, binPath)
	run.Env = env
	run.Stdout = w
	run.Stderr = w

	if err := run.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("timeout: el programa superó los 30 segundos de ejecución")
		}
		return fmt.Errorf("runtime error: %w", err)
	}

	return nil
}
