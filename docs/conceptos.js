export const CONCEPTOS = [
  {
    keyword: "goroutine",
    titulo: "Función que corre concurrentemente",
    desc: `Una <strong>goroutine</strong> es una función que Go ejecuta de forma concurrente con el resto del programa. Se lanza con la palabra clave <strong>go</strong> y es extremadamente liviana — podés tener miles corriendo al mismo tiempo. No es un thread del sistema operativo, es manejada por el runtime de Go.`,
    pasos: [
      "main llega a `go f()` — registra la goroutine y sigue inmediatamente, no espera",
      "El scheduler de Go decide cuándo darle CPU a la goroutine",
      "La goroutine corre de forma independiente hasta que termina o se bloquea",
      "Cuando main termina, todas las goroutines se cancelan — aunque no hayan terminado",
    ],
    codigo: `go func() {
    fmt.Println("corro en paralelo")
}()
// main sigue sin esperar`,
  },
  {
    keyword: "scheduler",
    titulo: "El scheduler de Go — cómo se reparte el CPU",
    desc: `El <strong>scheduler</strong> de Go decide qué goroutine corre en cada momento. Es <strong>cooperativo</strong>: una goroutine corre hasta que llega a un punto donde naturalmente tiene que esperar — un channel, un sleep, I/O. En ese momento el scheduler la pausa y le da el control a otra. En una máquina real puede usar múltiples cores (paralelo real). En este playground corre en un solo thread (WASM).`,
    pasos: [
      "goroutine-1 corre hasta que hace ch <- val o time.Sleep",
      "El scheduler la pausa y busca otra goroutine lista para correr",
      "goroutine-2 corre hasta que también se bloquea o termina",
      "El scheduler vuelve a goroutine-1 cuando el channel o sleep se resuelve",
    ],
    codigo: `go func() {
    time.Sleep(50 * time.Millisecond) // ← punto de cesión
    ch <- "dato"                       // ← punto de cesión
}()`,
  },
  {
    keyword: "channel",
    titulo: "Canal de comunicación entre goroutines",
    desc: `Un <strong>channel</strong> es el mecanismo de Go para que las goroutines se comuniquen y sincronicen. La filosofía de Go es: en vez de compartir memoria y protegerla con locks, comunicarse a través de channels. Un channel <strong>unbuffered</strong> bloquea al que envía hasta que alguien recibe, y viceversa — esto garantiza sincronización.`,
    pasos: [
      "main crea el channel con make(chan T)",
      "goroutine intenta enviar ch <- val — se bloquea si nadie está esperando",
      "main llega a <-ch — se bloquea si nadie envió todavía",
      "Cuando ambos están listos, el valor se transfiere y ambos continúan",
    ],
    codigo: `ch := make(chan string)    // unbuffered

go func() {
    ch <- "hola"  // bloquea hasta que main reciba
}()

msg := <-ch       // bloquea hasta que la goroutine envíe
fmt.Println(msg)`,
  },
  {
    keyword: "make",
    titulo: "Crear channels, slices y maps",
    desc: `<strong>make</strong> inicializa channels, slices y maps — los tres tipos que necesitan inicialización interna antes de usarse. Para channels, <strong>make(chan T)</strong> crea un channel unbuffered y <strong>make(chan T, n)</strong> crea uno con buffer de tamaño n. Un channel buffered no bloquea al enviar hasta que el buffer se llena.`,
    pasos: [
      "make(chan int) — unbuffered, enviar bloquea hasta que alguien reciba",
      "make(chan int, 3) — buffered, enviar no bloquea si hay espacio en el buffer",
      "Cuando el buffer se llena, el siguiente envío bloquea igual que unbuffered",
      "close(ch) avisa a los receptores que no hay más valores",
    ],
    codigo: `ch1 := make(chan int)     // unbuffered
ch2 := make(chan int, 3)  // buffered — cabe 3 sin bloquear

ch2 <- 1  // no bloquea
ch2 <- 2  // no bloquea
ch2 <- 3  // no bloquea
ch2 <- 4  // bloquea — buffer lleno`,
  },
  {
    keyword: "select",
    titulo: "Esperar en múltiples channels a la vez",
    desc: `<strong>select</strong> es como un switch pero para channels — espera al primero que esté listo. Si varios están listos al mismo tiempo, elige uno al azar. Es la forma idiomática de Go para manejar timeouts, cancelaciones y múltiples fuentes de datos concurrentes.`,
    pasos: [
      "select bloquea hasta que alguno de los cases esté listo",
      "Si ch1 recibe primero, ejecuta ese case y continúa",
      "time.After(d) crea un channel que recibe después de d — sirve para timeouts",
      "Un case default hace que select no bloquee nunca",
    ],
    codigo: `select {
case msg := <-ch1:
    fmt.Println("ch1:", msg)
case msg := <-ch2:
    fmt.Println("ch2:", msg)
case <-time.After(1 * time.Second):
    fmt.Println("timeout")
}`,
  },
  {
    keyword: "defer",
    titulo: "Ejecutar al salir de la función",
    desc: `<strong>defer</strong> registra una llamada que se ejecuta cuando la función retorna, sin importar cómo — return normal, panic, o cualquier camino. Se usa para cleanup: cerrar archivos, desbloquear mutexes, cerrar channels. Múltiples defers se ejecutan en orden LIFO (último en registrarse, primero en ejecutarse).`,
    pasos: [
      "defer wg.Done() se registra al entrar a la función",
      "La función hace su trabajo normalmente",
      "Cuando la función retorna (por cualquier motivo), defer se ejecuta",
      "Garantiza que wg.Done() se llame aunque haya un panic",
    ],
    codigo: `func worker(wg *sync.WaitGroup) {
    defer wg.Done() // se ejecuta al salir, pase lo que pase

    // trabajo...
    fmt.Println("trabajando")
} // ← wg.Done() se llama acá`,
  },
  {
    keyword: "WaitGroup",
    titulo: "Esperar a que un conjunto de goroutines termine",
    desc: `<strong>sync.WaitGroup</strong> es un contador que permite a main (u otra goroutine) esperar a que un grupo de goroutines termine. Se incrementa con <strong>Add</strong> antes de lanzar cada goroutine, se decrementa con <strong>Done</strong> al terminar, y <strong>Wait</strong> bloquea hasta que el contador llega a cero.`,
    pasos: [
      "wg.Add(n) antes de lanzar las goroutines — registra cuántas hay",
      "Cada goroutine llama defer wg.Done() al terminar — resta 1",
      "wg.Wait() bloquea a main hasta que todas llamaron Done()",
      "Cuando el contador llega a 0, Wait() desbloquea y main continúa",
    ],
    codigo: `var wg sync.WaitGroup

for i := 0; i < 3; i++ {
    wg.Add(1)
    go func(id int) {
        defer wg.Done()
        fmt.Println("goroutine", id)
    }(i)
}

wg.Wait() // espera a las 3`,
  },
  {
    keyword: "close",
    titulo: "Cerrar un channel",
    desc: `<strong>close(ch)</strong> señaliza que no se van a enviar más valores por el channel. Los receptores pueden detectarlo con <strong>v, ok := <-ch</strong> donde ok es false cuando el channel está cerrado. El patrón <strong>for range</strong> sobre un channel itera hasta que se cierra automáticamente.`,
    pasos: [
      "El productor envía todos sus valores por el channel",
      "close(ch) avisa que no hay más — los receptores lo detectan",
      "for v := range ch recibe hasta que el channel se cierra y para solo",
      "Cerrar un channel dos veces o enviar a uno cerrado causa panic",
    ],
    codigo: `ch := make(chan int)

go func() {
    for _, n := range []int{1, 2, 3} {
        ch <- n
    }
    close(ch) // avisa que terminó
}()

for v := range ch { // para cuando ch se cierra
    fmt.Println(v)
}`,
  },
];
