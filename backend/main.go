package main

import (
	"fmt"
	"log"
	"net/http"
	"time"
)

func main() {
	mux := http.NewServeMux()

	mux.HandleFunc("/run", handleRun)
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/debug-instrument", handleDebugInstrument)

	addr := ":8080"
	fmt.Printf("Backend corriendo en http://localhost%s\n", addr)
	log.Fatal(http.ListenAndServe(addr, withCORS(mux)))
}

func handleDebugInstrument(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	code := r.FormValue("code")
	if code == "" {
		http.Error(w, "falta 'code'", http.StatusBadRequest)
		return
	}
	result, err := InstrumentCode(code)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintln(w, result)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintln(w, `{"status":"ok"}`)
}

// handleRun recibe código Go, lo instrumenta, compila y ejecuta.
// Streamea los eventos de traza como Server-Sent Events (SSE).
func handleRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método no permitido", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		if err2 := r.ParseForm(); err2 != nil {
			http.Error(w, "error leyendo el body", http.StatusBadRequest)
			return
		}
	}

	code := r.FormValue("code")
	if code == "" {
		http.Error(w, "campo 'code' requerido", http.StatusBadRequest)
		return
	}

	modo := ModoEjecucion(r.FormValue("modo"))
	switch modo {
	case ModoCooperativo, ModoConcurrente, ModoParalelo:
		// válido
	default:
		modo = ModoConcurrente // default
	}

	// Instrumentar
	instrumented, err := InstrumentCode(code)
	if err != nil {
		log.Printf("[run] error instrumentando: %v", err)
		http.Error(w, fmt.Sprintf("error instrumentando: %v", err), http.StatusBadRequest)
		return
	}
	log.Printf("[run] código instrumentado OK (%d bytes)", len(instrumented))

	// Configurar SSE
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming no soportado", http.StatusInternalServerError)
		return
	}

	// sseWriter convierte cada línea JSON del binario en un evento SSE
	sw := &sseWriter{w: w, flusher: flusher}

	// Compilar y ejecutar — los eventos llegan line by line via sw
	log.Printf("[run] compilando y ejecutando...")
	if err := CompileAndRun(instrumented, sw, modo); err != nil {
		log.Printf("[run] error: %v", err)
		fmt.Fprintf(w, "event: error\ndata: %s\n\n", err.Error())
		flusher.Flush()
		return
	}
	log.Printf("[run] ejecución terminada OK")

	// Señal de fin con timestamp
	fmt.Fprintf(w, "data: {\"event\":\"done\",\"goroutine\":\"main\",\"detail\":\"\",\"ts\":%d}\n\n", time.Now().UnixMicro())
	flusher.Flush()
}

// sseWriter envuelve un http.ResponseWriter y formatea cada línea como SSE.
type sseWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
	buf     []byte
}

func (s *sseWriter) Write(p []byte) (int, error) {
	s.buf = append(s.buf, p...)
	// Procesar líneas completas
	for {
		idx := -1
		for i, b := range s.buf {
			if b == '\n' {
				idx = i
				break
			}
		}
		if idx == -1 {
			break
		}
		line := s.buf[:idx]
		s.buf = s.buf[idx+1:]
		if len(line) == 0 {
			continue
		}
		fmt.Fprintf(s.w, "data: %s\n\n", line)
		s.flusher.Flush()
	}
	return len(p), nil
}

func withCORS(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}
