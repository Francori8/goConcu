# Go Concurrency Playground

Playground interactivo para explorar concurrencia en Go real, ejecutado en el navegador via WebAssembly.

Proyecto hermano de [simuladorThreads](../simuladorThreads) — donde los conceptos de concurrencia se simulan con pseudocódigo controlado, acá se prueban en Go real con su propio runtime y scheduler.

---

## Idea central

El simulador de threads muestra *qué pasa* cuando múltiples threads compiten por memoria compartida — race conditions, deadlocks, semáforos.

Este playground muestra *la otra forma de pensar la concurrencia*: la filosofía de Go.

> **"Don't communicate by sharing memory; share memory by communicating."**

---

## Recorrido pedagógico

### 1. El problema — memoria compartida (1-2 ejemplos)
- Variables compartidas sin sincronización → race condition
- `sync.Mutex` para protegerlas → funciona pero es frágil

El objetivo de estos ejemplos no es enseñar mutexes, sino mostrar *por qué Go propone otra cosa*.

### 2. La solución de Go — channels y goroutines
- Goroutines básicas
- Channels unbuffered — sincronización implícita
- Channels buffered — desacople productor/consumidor
- `select` — múltiples channels a la vez
- `sync.WaitGroup` — esperar que terminen goroutines

### 3. Patrones clásicos en Go
- Fan-out: una goroutine distribuye trabajo a varias
- Pipeline: goroutines encadenadas por channels
- Worker pool: N workers procesando una cola de tareas

---

## Stack técnico

| Componente | Decisión |
|---|---|
| Backend | Go — servidor HTTP minimalista |
| Compilación | TinyGo (`tinygo build`) en el backend |
| Ejecución en browser | WebAssembly (bytes devueltos por el backend) |
| Editor de código | Monaco Editor (el de VS Code, libre) |
| Trazas | Inyectadas automáticamente por el backend antes de compilar |
| UI | HTML/CSS/JS vanilla (como el simulador) |
| Comunicación Go → JS | `syscall/js` — el código Go manda eventos a JS en tiempo real |

### Flujo completo

```
Usuario escribe código Go limpio
        ↓
Frontend POST /compile (código como texto)
        ↓
Backend inyecta instrumentación de trazas automáticamente
        ↓
Backend ejecuta tinygo build → genera .wasm
        ↓
Backend devuelve los bytes del .wasm
        ↓
Frontend instancia el WebAssembly en el browser
        ↓
Go corre en el browser, manda eventos a JS via syscall/js
        ↓
JS dibuja las trazas en la UI (al estilo del simulador)
```

### Instrumentación automática (backend)

El usuario escribe código Go limpio sin ninguna librería especial. El backend, antes de compilar, parsea e inyecta llamadas de traza en los puntos clave:

- Antes y después de enviar/recibir en un channel (`ch <- val`, `<-ch`)
- Al lanzar una goroutine (`go func()`)
- Al bloquear/desbloquear un mutex

Así el usuario ve trazas detalladas sin tener que instrumentar nada manualmente.

---

## Lo que NO incluye (a propósito)

- Semáforos — en Go se emulan con channels, no es idiomático. Para semáforos, ver el simulador
- Ejemplos complejos de `sync` — el punto es mostrar channels, no replicar el simulador en Go
- Ejecución de proyectos reales — es un playground educativo, no un entorno de desarrollo

---

## Estado

- [x] Definir stack técnico
- [ ] Setup del backend Go (servidor + endpoint /compile)
- [ ] Integrar TinyGo en el backend
- [ ] Inyección automática de trazas en el backend
- [ ] Frontend básico con Monaco Editor
- [ ] Integración WASM en el browser (syscall/js)
- [ ] UI de trazas al estilo del simulador
- [ ] Ejemplos de memoria compartida (1-2)
- [ ] Ejemplos de channels y goroutines
- [ ] Patrones: fan-out, pipeline, worker pool
