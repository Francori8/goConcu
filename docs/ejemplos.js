export const EJEMPLOS = [
  {
    categoria: "Goroutines",
    categorias: [
      {
        nombre: "Básicos",
        ejemplos: [
          {
            nombre: "Primera goroutine",
            codigo: `package main

import (
	"fmt"
	"time"
)

func decir(msg string) {
	fmt.Println(msg)
}

func main() {
	// go lanza decir() en una goroutine separada — no bloquea
	go decir("goroutine")

	// main sigue ejecutando sin esperar
	time.Sleep(10 * time.Millisecond)
	fmt.Println("main")
}
`,
          },
          {
            nombre: "WaitGroup",
            codigo: `package main

import (
	"fmt"
	"sync"
)

func tarea(id int, wg *sync.WaitGroup) {
	defer wg.Done() // avisa que esta goroutine terminó
	fmt.Printf("tarea %d ejecutándose\\n", id)
}

func main() {
	var wg sync.WaitGroup

	// Lanzar 3 goroutines
	for i := 1; i <= 3; i++ {
		wg.Add(1)        // registrar una goroutine más
		go tarea(i, &wg)
	}

	wg.Wait() // esperar a que todas terminen
	fmt.Println("todas las tareas terminaron")
}
`,
          },
        ],
      },
    ],
  },
  {
    categoria: "Channels",
    categorias: [
      {
        nombre: "Fundamentos",
        ejemplos: [
          {
            nombre: "Unbuffered",
            codigo: `package main

import "fmt"

func main() {
	ch := make(chan string)

	// La goroutine envía — bloquea hasta que main reciba
	go func() {
		ch <- "hola desde goroutine"
	}()

	// main recibe — bloquea hasta que la goroutine envíe
	msg := <-ch
	fmt.Println(msg)
}
`,
          },
          {
            nombre: "Buffered",
            codigo: `package main

import "fmt"

func main() {
	ch := make(chan int, 3) // buffer de 3 — no bloquea hasta llenarse

	ch <- 1 // no bloquea, hay espacio
	ch <- 2
	ch <- 3
	// ch <- 4 // esto sí bloquearía — buffer lleno

	fmt.Println(<-ch) // 1
	fmt.Println(<-ch) // 2
	fmt.Println(<-ch) // 3
}
`,
          },
          {
            nombre: "Range sobre channel",
            codigo: `package main

import "fmt"

func generar(nums ...int) <-chan int {
	ch := make(chan int)
	go func() {
		for _, n := range nums {
			ch <- n
		}
		close(ch) // cerrar avisa que no hay más valores
	}()
	return ch
}

func main() {
	// range sobre un channel recibe hasta que se cierra
	for n := range generar(1, 2, 3, 4, 5) {
		fmt.Println(n)
	}
}
`,
          },
        ],
      },
      {
        nombre: "Select",
        ejemplos: [
          {
            nombre: "Select básico",
            codigo: `package main

import (
	"fmt"
	"time"
)

func main() {
	ch1 := make(chan string)
	ch2 := make(chan string)

	go func() {
		time.Sleep(50 * time.Millisecond)
		ch1 <- "uno"
	}()

	go func() {
		time.Sleep(20 * time.Millisecond)
		ch2 <- "dos"
	}()

	// select espera al primero que llegue
	for i := 0; i < 2; i++ {
		select {
		case msg := <-ch1:
			fmt.Println("ch1:", msg)
		case msg := <-ch2:
			fmt.Println("ch2:", msg)
		}
	}
}
`,
          },
          {
            nombre: "Timeout",
            codigo: `package main

import (
	"fmt"
	"time"
)

func operacionLenta() <-chan string {
	ch := make(chan string)
	go func() {
		time.Sleep(100 * time.Millisecond)
		ch <- "resultado"
	}()
	return ch
}

func main() {
	ch := operacionLenta()

	select {
	case res := <-ch:
		fmt.Println("recibido:", res)
	case <-time.After(50 * time.Millisecond):
		fmt.Println("timeout — la operación tardó demasiado")
	}
}
`,
          },
          {
            nombre: "Done channel",
            codigo: `package main

import (
	"fmt"
	"time"
)

func worker(done <-chan bool) {
	for {
		select {
		case <-done:
			fmt.Println("worker: recibí señal de stop")
			return
		default:
			fmt.Println("worker: trabajando...")
			time.Sleep(20 * time.Millisecond)
		}
	}
}

func main() {
	done := make(chan bool)

	go worker(done)

	time.Sleep(60 * time.Millisecond)
	done <- true // señal de stop
	time.Sleep(10 * time.Millisecond)
	fmt.Println("main: terminado")
}
`,
          },
        ],
      },
    ],
  },
  {
    categoria: "Patrones",
    categorias: [
      {
        nombre: "Clásicos",
        ejemplos: [
          {
            nombre: "Pipeline",
            codigo: `package main

import "fmt"

// Etapa 1: genera números
func generar(nums ...int) <-chan int {
	out := make(chan int)
	go func() {
		for _, n := range nums {
			out <- n
		}
		close(out)
	}()
	return out
}

// Etapa 2: eleva al cuadrado
func cuadrados(in <-chan int) <-chan int {
	out := make(chan int)
	go func() {
		for n := range in {
			out <- n * n
		}
		close(out)
	}()
	return out
}

func main() {
	// Encadenar etapas: generar → cuadrados → imprimir
	for v := range cuadrados(generar(1, 2, 3, 4, 5)) {
		fmt.Println(v)
	}
}
`,
          },
          {
            nombre: "Fan-out",
            codigo: `package main

import (
	"fmt"
	"sync"
)

func worker(id int, tareas <-chan int, wg *sync.WaitGroup) {
	defer wg.Done()
	for t := range tareas {
		fmt.Printf("worker %d procesó tarea %d\\n", id, t)
	}
}

func main() {
	tareas := make(chan int, 9)
	var wg sync.WaitGroup

	// Fan-out: distribuir trabajo entre 3 workers
	for i := 1; i <= 3; i++ {
		wg.Add(1)
		go worker(i, tareas, &wg)
	}

	for t := 1; t <= 9; t++ {
		tareas <- t
	}
	close(tareas)

	wg.Wait()
	fmt.Println("listo")
}
`,
          },
          {
            nombre: "Worker pool",
            codigo: `package main

import (
	"fmt"
	"sync"
)

func worker(id int, jobs <-chan int, results chan<- int, wg *sync.WaitGroup) {
	defer wg.Done()
	for j := range jobs {
		results <- j * j
	}
}

func main() {
	jobs    := make(chan int, 10)
	results := make(chan int, 10)
	var wg sync.WaitGroup

	for w := 1; w <= 3; w++ {
		wg.Add(1)
		go worker(w, jobs, results, &wg)
	}

	for j := 1; j <= 6; j++ {
		jobs <- j
	}
	close(jobs)

	go func() {
		wg.Wait()
		close(results)
	}()

	for r := range results {
		fmt.Println(r)
	}
}
`,
          },
        ],
      },
    ],
  },
];
