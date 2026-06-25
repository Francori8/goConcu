import { EJEMPLOS } from "./ejemplos.js";
import { CONCEPTOS } from "./conceptos.js";

const BACKEND_URL = window.location.hostname === "localhost"
  ? "http://localhost:8080"
  : "https://TU-BACKEND.railway.app"; // ← reemplazar después del deploy

// ── Estado ────────────────────────────────────────────────────────────────

let editor = null;       // instancia de Monaco
let goroutines = {};     // mapa de goroutines activas { nombre: { estado, colorIdx } }
let trazaInicio = null;  // timestamp del primer evento
let eventos = [];        // todos los eventos acumulados para el diagrama
let goroutineOrden = []; // orden de aparición de goroutines para los carriles
let colorCounter = 0;    // contador para asignar colores

const COLORES = ["seq-color-0","seq-color-1","seq-color-2","seq-color-3","seq-color-4","seq-color-5"];

// ── Elementos del DOM ─────────────────────────────────────────────────────

const btnEjecutar       = document.getElementById("btn-ejecutar");
const btnLimpiar        = document.getElementById("btn-limpiar");
const modosBtns         = document.querySelectorAll(".modo-btn");

let modoActual = "cooperativo";

modosBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    modosBtns.forEach(b => b.classList.remove("modo-activo"));
    btn.classList.add("modo-activo");
    modoActual = btn.dataset.modo;
  });
});
const btnToggleEjemp    = document.getElementById("btn-toggle-ejemplos");
const panelEjemplos     = document.getElementById("panel-ejemplos");
const contenedorBotones = document.getElementById("contenedor-botones");
const panelError        = document.getElementById("panel-error");
const goroutinesLista   = document.getElementById("goroutines-lista");
const trazaEl           = document.getElementById("traza");
const diagramaEl        = document.getElementById("diagrama");
const estadoBadge       = document.getElementById("estado-wasm");

// ── Monaco Editor ─────────────────────────────────────────────────────────

require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs" } });

require(["vs/editor/editor.main"], () => {
  editor = monaco.editor.create(document.getElementById("monaco-editor"), {
    value: EJEMPLOS[0].categorias[0].ejemplos[0].codigo,
    language: "go",
    theme: "vs-dark",
    fontSize: 14,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontFamily: "'Fira Mono', 'Consolas', monospace",
    automaticLayout: true,
    lineNumbers: "on",
    renderLineHighlight: "line",
    padding: { top: 12, bottom: 12 },
  });

  // Ctrl+Enter / Cmd+Enter para ejecutar
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, ejecutar);
});

// ── Panel de ejemplos ─────────────────────────────────────────────────────

function renderEjemplos() {
  contenedorBotones.innerHTML = "";

  for (const grupo of EJEMPLOS) {
    const div = document.createElement("div");
    div.className = "ejemplo-grupo";

    const btnCat = document.createElement("button");
    btnCat.className = "ejemplo-categoria";
    btnCat.textContent = grupo.categoria;
    btnCat.setAttribute("aria-expanded", "true");

    const listaBotones = document.createElement("div");
    listaBotones.className = "ejemplo-botones";
    const slug = grupo.categoria.toLowerCase().replace(/\s+/g, "-");

    for (const cat of grupo.categorias) {
      for (const ej of cat.ejemplos) {
        const btn = document.createElement("button");
        btn.className = `ejemplo-btn ejemplo-btn--${slug}`;
        btn.textContent = ej.nombre;
        btn.addEventListener("click", () => {
          editor?.setValue(ej.codigo);
          limpiarTraza();
        });
        listaBotones.appendChild(btn);
      }
    }

    btnCat.addEventListener("click", () => {
      const abierto = btnCat.getAttribute("aria-expanded") === "true";
      btnCat.setAttribute("aria-expanded", String(!abierto));
      listaBotones.hidden = abierto;
    });

    div.appendChild(btnCat);
    div.appendChild(listaBotones);
    contenedorBotones.appendChild(div);
  }
}

btnToggleEjemp.addEventListener("click", () => {
  const abierto = btnToggleEjemp.getAttribute("aria-expanded") === "true";
  btnToggleEjemp.setAttribute("aria-expanded", String(!abierto));
  panelEjemplos.hidden = abierto;
});

// ── Ejecutar ──────────────────────────────────────────────────────────────

btnEjecutar.addEventListener("click", ejecutar);
btnLimpiar.addEventListener("click", limpiarTraza);

async function ejecutar() {
  const codigo = editor?.getValue();
  if (!codigo?.trim()) return;

  limpiarTraza();
  setEstado("compilando");
  btnEjecutar.disabled = true;
  ocultarError();

  const formData = new FormData();
  formData.append("code", codigo);
  formData.append("modo", modoActual);

  try {
    const res = await fetch(`${BACKEND_URL}/run`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const msg = await res.text();
      mostrarError(msg);
      setEstado("listo");
      btnEjecutar.disabled = false;
      return;
    }

    setEstado("corriendo");

    // Leer el stream SSE manualmente desde el body
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // última línea incompleta

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const json = line.slice(6).trim();
          if (!json) continue;
          try {
            const ev = JSON.parse(json);
            agregarTraza(ev);
          } catch {
            // línea no-JSON (stderr del binario) — ignorar
          }
        } else if (line.startsWith("event: error")) {
          // el siguiente data: tendrá el mensaje
        } else if (line.startsWith("event: done")) {
          // fin normal
        }
      }
    }
  } catch (err) {
    mostrarError(`Error de red: ${err.message}`);
  } finally {
    setEstado("listo");
    btnEjecutar.disabled = false;
  }
}

// ── Trazas ────────────────────────────────────────────────────────────────

function agregarTraza(ev) {
  // Calcular tiempo relativo al primer evento
  if (trazaInicio === null) trazaInicio = ev.ts;
  const tsRelativo = ev.ts - trazaInicio; // en microsegundos
  ev._tsRel = tsRelativo;

  // Acumular evento y actualizar diagrama
  eventos.push(ev);
  actualizarGoroutine(ev.goroutine, ev.event, ev.detail);
  renderDiagrama();

  // Quitar mensaje vacío
  const vacia = trazaEl.querySelector(".traza-vacia");
  if (vacia) vacia.remove();

  const item = document.createElement("div");
  item.className = "traza-item";
  item.dataset.event = ev.event;

  const ts = document.createElement("span");
  ts.className = "traza-ts";
  ts.textContent = `+${(tsRelativo / 1000).toFixed(3)}ms`;

  const goroutine = document.createElement("span");
  goroutine.className = "traza-goroutine";
  goroutine.textContent = ev.goroutine || "main";

  const event = document.createElement("span");
  event.className = "traza-event";
  event.textContent = ev.event;

  const detail = document.createElement("span");
  detail.className = "traza-detail";
  detail.textContent = ev.detail || "";

  item.appendChild(ts);
  item.appendChild(goroutine);
  item.appendChild(event);
  item.appendChild(detail);
  trazaEl.appendChild(item);

  // Auto-scroll
  trazaEl.scrollTop = trazaEl.scrollHeight;
}

function actualizarGoroutine(nombre, evento, detail) {
  if (!nombre) nombre = "main";

  if (!goroutines[nombre]) {
    const colorIdx = colorCounter % COLORES.length;
    colorCounter++;
    goroutines[nombre] = { estado: "corriendo", colorIdx, fn: null };
    goroutineOrden.push(nombre);
    renderGoroutineChip(nombre, colorIdx);
  }

  const g = goroutines[nombre];

  if (evento === "goroutine-start" && detail) {
    g.fn = detail; // guardar nombre de función ej: "worker(...)"
    const chip = document.querySelector(`.goroutine-chip[data-nombre="${nombre}"]`);
    if (chip) chip.title = detail;
    // actualizar header del carril en el diagrama si ya existe
    const header = document.querySelector(`.seq-carril-header[data-nombre="${nombre}"]`);
    if (header) header.textContent = `${nombre} ${detail}`;
  } else if (evento === "goroutine-end") {
    g.estado = "terminada";
  } else if (evento === "chan-block" || evento === "mutex-lock") {
    g.estado = "bloqueada";
  } else if (evento === "chan-send" || evento === "chan-recv" || evento === "mutex-unlock") {
    g.estado = "corriendo";
  }

  const chip = document.querySelector(`.goroutine-chip[data-nombre="${nombre}"]`);
  if (chip) chip.dataset.estado = g.estado;
}

function renderGoroutineChip(nombre, colorIdx) {
  const chip = document.createElement("div");
  chip.className = `goroutine-chip ${COLORES[colorIdx % COLORES.length]}`;
  chip.dataset.nombre = nombre;
  chip.dataset.estado = "corriendo";
  chip.textContent = nombre;
  goroutinesLista.appendChild(chip);
}

// ── Diagrama de secuencia ─────────────────────────────────────────────────

function renderDiagrama() {
  if (goroutineOrden.length === 0) return;

  diagramaEl.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "seq-grid";

  // Crear un carril por goroutine
  const carriles = {};
  for (const nombre of goroutineOrden) {
    const g = goroutines[nombre];
    const colorClass = COLORES[g.colorIdx % COLORES.length];

    const carril = document.createElement("div");
    carril.className = "seq-carril";

    const header = document.createElement("div");
    header.className = `seq-carril-header ${colorClass}`;
    header.dataset.nombre = nombre;
    header.textContent = g.fn ? `${nombre} ${g.fn}` : nombre;

    const linea = document.createElement("div");
    linea.className = "seq-linea";

    const eventosDiv = document.createElement("div");
    eventosDiv.className = "seq-eventos";

    carril.appendChild(header);
    carril.appendChild(linea);
    carril.appendChild(eventosDiv);
    grid.appendChild(carril);
    carriles[nombre] = eventosDiv;
  }

  // Renderizar eventos — cada evento agrega una fila en su carril
  // y filas vacías en los demás para mantener alineación
  for (const ev of eventos) {
    const nombre = ev.goroutine || "main";
    const label = labelEvento(ev);

    for (const g of goroutineOrden) {
      const esActivo = g === nombre;
      const contenedor = carriles[g];

      const fila = document.createElement("div");
      fila.className = "seq-fila";
      fila.style.justifyContent = "center";

      if (esActivo) {
        const punto = document.createElement("div");
        punto.className = "seq-punto";
        punto.dataset.event = ev.event;

        const lbl = document.createElement("span");
        lbl.className = "seq-label";
        lbl.dataset.event = ev.event;
        lbl.textContent = label;

        fila.appendChild(punto);
        fila.appendChild(lbl);
      } else {
        // Carril inactivo — solo un espacio para mantener alineación
        const vacio = document.createElement("div");
        vacio.className = "seq-vacio";
        fila.appendChild(vacio);
      }

      contenedor.appendChild(fila);
    }
  }

  diagramaEl.appendChild(grid);
  diagramaEl.scrollTop = diagramaEl.scrollHeight;
}

function labelEvento(ev) {
  switch (ev.event) {
    case "goroutine-launch": return `go ${ev.detail}`;
    case "goroutine-start":  return `start ${ev.detail}`;
    case "goroutine-end":    return `end ${ev.detail}`;
    case "chan-send":         return `send ${ev.detail}`;
    case "chan-recv":         return `recv ${ev.detail}`;
    case "chan-close":        return ev.detail;
    case "chan-block":        return "block";
    case "wg-add":           return ev.detail;
    case "wg-done":          return ev.detail;
    case "mutex-lock":       return "lock";
    case "mutex-unlock":     return "unlock";
    case "sleep":            return ev.detail || "sleep";
    case "print":            return ev.detail?.trim() || "print";
    case "done":             return "done";
    default:                 return ev.event;
  }
}

function limpiarTraza() {
  trazaEl.innerHTML = '<span class="traza-vacia">Ejecutá un programa para ver la traza...</span>';
  diagramaEl.innerHTML = '<span class="seq-vacia">Ejecutá un programa para ver el diagrama...</span>';
  goroutinesLista.innerHTML = "";
  goroutines = {};
  goroutineOrden = [];
  eventos = [];
  colorCounter = 0;
  trazaInicio = null;
  ocultarError();
  setEstado("listo");
}

// ── UI helpers ────────────────────────────────────────────────────────────

function setEstado(estado) {
  const textos = {
    compilando: "Compilando...",
    corriendo:  "Corriendo",
    listo:      "",
  };
  estadoBadge.textContent = textos[estado] || "";
  estadoBadge.dataset.estado = estado;
  estadoBadge.hidden = estado === "listo";
}

function mostrarError(msg) {
  panelError.textContent = msg;
  panelError.hidden = false;
}

function ocultarError() {
  panelError.hidden = true;
  panelError.textContent = "";
}

// ── Tabs ──────────────────────────────────────────────────────────────────

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("tab-activa"));
    document.querySelectorAll(".tab-contenido").forEach(c => c.hidden = true);
    btn.classList.add("tab-activa");
    document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
  });
});

// ── Conceptos ─────────────────────────────────────────────────────────────

function renderConceptos() {
  const el = document.getElementById("conceptos");
  el.innerHTML = "";

  for (const c of CONCEPTOS) {
    const item = document.createElement("div");
    item.className = "concepto-item";

    const header = document.createElement("div");
    header.className = "concepto-header";
    header.innerHTML = `
      <span class="concepto-keyword">${c.keyword}</span>
      <span class="concepto-titulo">${c.titulo}</span>
      <span class="concepto-arrow">▶</span>
    `;

    const body = document.createElement("div");
    body.className = "concepto-body";
    body.innerHTML = `
      <p class="concepto-desc">${c.desc}</p>
      <div class="concepto-pasos">
        <div class="concepto-pasos-titulo">Qué pasa cuando ejecutás</div>
        ${c.pasos.map((p, i) => `
          <div class="concepto-paso">
            <span class="concepto-paso-num">${i + 1}.</span>
            <span>${p}</span>
          </div>
        `).join("")}
      </div>
      <pre class="concepto-code">${c.codigo}</pre>
    `;

    header.addEventListener("click", () => {
      const abierto = item.classList.toggle("abierto");
      // Cerrar los demás
      if (abierto) {
        el.querySelectorAll(".concepto-item.abierto").forEach(other => {
          if (other !== item) other.classList.remove("abierto");
        });
      }
    });

    item.appendChild(header);
    item.appendChild(body);
    el.appendChild(item);
  }
}

// ── Divisor arrastrable ───────────────────────────────────────────────────

const divisor         = document.getElementById("divisor");
const contenedorMain  = document.querySelector("main");

divisor.addEventListener("mousedown", (e) => {
  e.preventDefault();
  divisor.classList.add("arrastrando");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  const onMove = (e) => {
    const mainRect = contenedorMain.getBoundingClientRect();
    // ancho del panel de ejemplos si está visible
    const aside = document.getElementById("panel-ejemplos");
    const asideW = aside.hidden ? 0 : aside.getBoundingClientRect().width;
    const disponible = mainRect.width - asideW - 5; // 5px del divisor
    let nuevoAncho = e.clientX - mainRect.left - asideW;
    nuevoAncho = Math.max(200, Math.min(nuevoAncho, disponible - 200));
    const pct = (nuevoAncho / disponible) * 100;
    document.getElementById("contenedor-editor").style.flex = `0 0 ${pct}%`;
  };

  const onUp = () => {
    divisor.classList.remove("arrastrando");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    editor?.layout(); // forzar Monaco a recalcular su tamaño
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// ── Init ──────────────────────────────────────────────────────────────────

renderEjemplos();
renderConceptos();
limpiarTraza();
