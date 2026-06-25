package main

import (
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"strings"
)

// importsRequeridos son los paquetes que necesita el código inyectado.
var importsRequeridos = []string{"bufio", "encoding/json", "fmt", "os", "runtime", "sync", "sync/atomic", "time"}

// InstrumentCode toma código Go del usuario y:
//  1. Valida que tenga package main y func main
//  2. Parsea el AST
//  3. Inyecta trazas en goroutines, channels y prints
//  4. Agrega el main() de WASM
// importsProhibidos son paquetes que permiten acceso directo al OS o ejecución arbitraria.
var importsProhibidos = []struct {
	pkg    string
	motivo string
}{
	{"os/exec", "ejecutar comandos del sistema operativo"},
	{"syscall", "acceso directo al sistema operativo"},
	{"unsafe", "acceso directo a memoria sin verificación de tipos"},
	{"plugin", "cargar código externo arbitrario"},
}

func InstrumentCode(code string) (string, error) {
	if !strings.Contains(code, "package main") {
		return "", fmt.Errorf("el código debe tener 'package main'")
	}
	if !strings.Contains(code, "func main()") {
		return "", fmt.Errorf("el código debe tener 'func main()'")
	}

	// Verificar imports prohibidos
	for _, p := range importsProhibidos {
		if strings.Contains(code, `"`+p.pkg+`"`) {
			return "", fmt.Errorf("import no permitido: \"%s\"\nMotivo: %s", p.pkg, p.motivo)
		}
	}

	// Reemplazar fmt.Println/Printf — usan __gGet() para saber en qué goroutine están
	code = strings.ReplaceAll(code, "fmt.Println(", "__println(")
	code = strings.ReplaceAll(code, "fmt.Printf(", "__printf(")
	code = strings.ReplaceAll(code, "fmt.Print(", "__println(")

	// Renombrar func main() → func __userMain()
	code = strings.Replace(code, "func main()", "func __userMain()", 1)

	// Agregar imports necesarios
	code = ensureImports(code, importsRequeridos)

	// Parsear el AST
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "", code, parser.ParseComments)
	if err != nil {
		return "", fmt.Errorf("error parseando: %w", err)
	}

	// Instrumentar el AST
	v := &instrumenter{fset: fset, goroutineCount: 0, bloquesVisitados: map[*ast.BlockStmt]bool{}}
	ast.Walk(v, f)

	// Regenerar el código desde el AST modificado
	var sb strings.Builder
	if err := format.Node(&sb, fset, f); err != nil {
		return "", fmt.Errorf("error regenerando código: %w", err)
	}

	result := sb.String() + "\n" + tracerFuncs + "\n" + nativeMain
	return result, nil
}

// instrumenter recorre el AST e inyecta llamadas a __trace.
type instrumenter struct {
	fset            *token.FileSet
	goroutineCount  int
	bloquesVisitados map[*ast.BlockStmt]bool
}

func (v *instrumenter) Visit(node ast.Node) ast.Visitor {
	// Solo instrumentamos FuncDecl y FuncLit — entramos a su bloque manualmente.
	// Esto evita que ast.Walk baje automáticamente y procese bloques dos veces.
	switch n := node.(type) {
	case *ast.FuncDecl:
		if n.Body != nil {
			v.instrumentarBloqueProfundo(n.Body)
		}
		return nil // no bajar más — ya lo hicimos manualmente
	case *ast.FuncLit:
		v.instrumentarBloqueProfundo(n.Body)
		return nil
	}
	return v
}

// instrumentarBloqueProfundo procesa un bloque y baja recursivamente a sub-bloques.
func (v *instrumenter) instrumentarBloqueProfundo(block *ast.BlockStmt) {
	if block == nil || v.bloquesVisitados[block] {
		return
	}
	v.bloquesVisitados[block] = true
	v.instrumentBlock(block)

	// Bajar recursivamente a los sub-bloques de cada statement
	for _, stmt := range block.List {
		v.bajarStmt(stmt)
	}
}

func (v *instrumenter) bajarStmt(stmt ast.Stmt) {
	switch s := stmt.(type) {
	case *ast.BlockStmt:
		v.instrumentarBloqueProfundo(s)
	case *ast.IfStmt:
		v.instrumentarBloqueProfundo(s.Body)
		if s.Else != nil {
			v.bajarStmt(s.Else)
		}
	case *ast.ForStmt:
		v.instrumentarBloqueProfundo(s.Body)
	case *ast.RangeStmt:
		v.instrumentarBloqueProfundo(s.Body)
	case *ast.SelectStmt:
		v.instrumentarBloqueProfundo(s.Body)
	case *ast.SwitchStmt:
		v.instrumentarBloqueProfundo(s.Body)
	case *ast.TypeSwitchStmt:
		v.instrumentarBloqueProfundo(s.Body)
	case *ast.CommClause:
		// case dentro de select
		for _, cs := range s.Body {
			v.bajarStmt(cs)
		}
	case *ast.CaseClause:
		for _, cs := range s.Body {
			v.bajarStmt(cs)
		}
	case *ast.GoStmt:
		// Ya fue procesado por instrumentBlock — no bajar
	case *ast.ExprStmt:
		if lit, ok := s.X.(*ast.CallExpr); ok {
			if fn, ok := lit.Fun.(*ast.FuncLit); ok {
				v.instrumentarBloqueProfundo(fn.Body)
			}
		}
	}
}

// wrapGoStmt instrumenta un GoStmt:
//
// Si es `go func() { ... }()` — inyecta las trazas al inicio del bloque existente.
// Si es `go f(args)`          — envuelve en func anónima con trazas.
func (v *instrumenter) wrapGoStmt(gs *ast.GoStmt, prefijo string) {
	desc := callDesc(gs.Call)

	// __gn := __gSet("goroutine") — asigna nombre único en runtime y lo guarda
	setGName := &ast.AssignStmt{
		Lhs: []ast.Expr{ast.NewIdent("__gn")},
		Tok: token.DEFINE,
		Rhs: []ast.Expr{&ast.CallExpr{
			Fun:  ast.NewIdent("__gSet"),
			Args: []ast.Expr{strLit(prefijo)},
		}},
	}
	// __trace("goroutine-start", __gn, desc) — incluye nombre de función en detail
	traceStart := exprStmt(&ast.CallExpr{
		Fun: ast.NewIdent("__trace"),
		Args: []ast.Expr{
			strLit("goroutine-start"),
			ast.NewIdent("__gn"),
			strLit(desc),
		},
	})
	// defer __trace("goroutine-end", __gn, desc)
	traceEnd := &ast.DeferStmt{Call: &ast.CallExpr{
		Fun: ast.NewIdent("__trace"),
		Args: []ast.Expr{
			strLit("goroutine-end"),
			ast.NewIdent("__gn"),
			strLit(desc),
		},
	}}

	stmts := []ast.Stmt{setGName, traceStart, traceEnd}

	if lit, ok := gs.Call.Fun.(*ast.FuncLit); ok {
		// instrumentar el contenido ANTES de agregar las trazas propias
		v.instrumentarBloqueProfundo(lit.Body)
		lit.Body.List = append(stmts, lit.Body.List...)
		return
	}

	originalCall := gs.Call
	gs.Call = &ast.CallExpr{
		Fun: &ast.FuncLit{
			Type: &ast.FuncType{Params: &ast.FieldList{}},
			Body: &ast.BlockStmt{
				List: append(stmts, exprStmt(originalCall)),
			},
		},
	}
}

// instrumentBlock recorre los statements de un bloque e inyecta trazas.
func (v *instrumenter) instrumentBlock(block *ast.BlockStmt) {
	var newList []ast.Stmt

	for _, stmt := range block.List {

		// go func() / go f() — emitir launch desde el caller y wrappear la goroutine
		if gs, ok := stmt.(*ast.GoStmt); ok {
			desc := callDesc(gs.Call)
			// goroutine-launch: quién lanza y qué función
			newList = append(newList, exprStmt(traceCall("goroutine-launch", "__gName", desc)))
			v.wrapGoStmt(gs, "goroutine")
			newList = append(newList, stmt)
			continue
		}

		// time.Sleep(d) — cede el control, importante mostrarlo
		if esSleep(stmt) {
			dur := sleepDuration(stmt)
			newList = append(newList, exprStmt(traceCall("sleep", "__gName", "sleep "+dur)))
			newList = append(newList, stmt)
			continue
		}

		// ch <- val
		if send, ok := stmt.(*ast.SendStmt); ok {
			chanName := exprStr(send.Chan)
			valName := exprStr(send.Value)
			detail := fmt.Sprintf("%s <- %s", chanName, valName)
			newList = append(newList, exprStmt(traceCall("chan-send", "__gName", detail)))
			newList = append(newList, stmt)
			continue
		}

		// `<-ch` como statement sin asignación
		if expr, ok := stmt.(*ast.ExprStmt); ok {
			if unary, ok := expr.X.(*ast.UnaryExpr); ok && unary.Op == token.ARROW {
				chanName := exprStr(unary.X)
				newList = append(newList, exprStmt(traceCall("chan-recv", "__gName", "<-"+chanName)))
				newList = append(newList, stmt)
				continue
			}
		}

		// `x := <-ch` o `x = <-ch`
		if assign, ok := stmt.(*ast.AssignStmt); ok {
			for _, rhs := range assign.Rhs {
				if unary, ok := rhs.(*ast.UnaryExpr); ok && unary.Op == token.ARROW {
					chanName := exprStr(unary.X)
					lhsName := exprStr(assign.Lhs[0])
					detail := fmt.Sprintf("%s := <-%s", lhsName, chanName)
					newList = append(newList, exprStmt(traceCall("chan-recv", "__gName", detail)))
				}
			}
		}

		// close(ch)
		if esClose(stmt) {
			chanName := closeArg(stmt)
			newList = append(newList, exprStmt(traceCall("chan-close", "__gName", "close("+chanName+")")))
			newList = append(newList, stmt)
			continue
		}

		// wg.Add(n) — útil para ver cuándo se registran goroutines en el WaitGroup
		if esWgAdd(stmt) {
			detail := wgAddDetail(stmt)
			newList = append(newList, exprStmt(traceCall("wg-add", "__gName", detail)))
			newList = append(newList, stmt)
			continue
		}

		// wg.Done() directo (sin defer)
		if esWgDone(stmt) {
			detail := wgDoneDetail(stmt)
			newList = append(newList, exprStmt(traceCall("wg-done", "__gName", detail)))
			newList = append(newList, stmt)
			continue
		}

		// defer wg.Done() — envolver para emitir traza cuando se ejecuta el defer
		if ds, ok := stmt.(*ast.DeferStmt); ok && esSelectorCallExpr(ds.Call, "Done") {
			detail := fmt.Sprintf("%s.Done()", exprStr(ds.Call.Fun.(*ast.SelectorExpr).X))
			// reemplazar por: defer func() { __trace("wg-done", __gGet(), detail); wg.Done() }()
			ds.Call = &ast.CallExpr{
				Fun: &ast.FuncLit{
					Type: &ast.FuncType{Params: &ast.FieldList{}},
					Body: &ast.BlockStmt{
						List: []ast.Stmt{
							exprStmt(traceCall("wg-done", "__gName", detail)),
							exprStmt(ds.Call),
						},
					},
				},
			}
			newList = append(newList, stmt)
			continue
		}

		newList = append(newList, stmt)
	}

	block.List = newList
}

// ── Helpers para construir nodos AST ──────────────────────────────────────

// traceCall construye: __trace("event", goroutine, "detail")
// Si goroutine es "__gName" se usa como identificador, no como string literal.
func traceCall(event, goroutine, detail string) *ast.CallExpr {
	var goroutineExpr ast.Expr
	if goroutine == "__gName" {
		// llamada a __gGet() para obtener el nombre de la goroutine actual
		goroutineExpr = &ast.CallExpr{Fun: ast.NewIdent("__gGet")}
	} else {
		goroutineExpr = strLit(goroutine)
	}
	return &ast.CallExpr{
		Fun: ast.NewIdent("__trace"),
		Args: []ast.Expr{
			strLit(event),
			goroutineExpr,
			strLit(detail),
		},
	}
}

// deferTraceCall construye: defer __trace("event", "goroutine", "detail")
func deferTraceCall(event, goroutine, detail string) *ast.DeferStmt {
	return &ast.DeferStmt{Call: traceCall(event, goroutine, detail)}
}

func exprStmt(x ast.Expr) *ast.ExprStmt {
	return &ast.ExprStmt{X: x}
}

// esSleep detecta si un statement es time.Sleep(...)
func esSleep(stmt ast.Stmt) bool {
	expr, ok := stmt.(*ast.ExprStmt)
	if !ok {
		return false
	}
	call, ok := expr.X.(*ast.CallExpr)
	if !ok {
		return false
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	return ok && pkg.Name == "time" && sel.Sel.Name == "Sleep"
}

// sleepDuration devuelve una representación del argumento de time.Sleep
func sleepDuration(stmt ast.Stmt) string {
	call := stmt.(*ast.ExprStmt).X.(*ast.CallExpr)
	if len(call.Args) == 0 {
		return ""
	}
	return exprStr(call.Args[0])
}

// esClose detecta close(ch)
func esClose(stmt ast.Stmt) bool {
	expr, ok := stmt.(*ast.ExprStmt)
	if !ok {
		return false
	}
	call, ok := expr.X.(*ast.CallExpr)
	if !ok {
		return false
	}
	fn, ok := call.Fun.(*ast.Ident)
	return ok && fn.Name == "close" && len(call.Args) == 1
}

func closeArg(stmt ast.Stmt) string {
	call := stmt.(*ast.ExprStmt).X.(*ast.CallExpr)
	return exprStr(call.Args[0])
}

// esWgAdd detecta wg.Add(n)
func esWgAdd(stmt ast.Stmt) bool {
	return esSelectorCall(stmt, "Add")
}

func wgAddDetail(stmt ast.Stmt) string {
	call := stmt.(*ast.ExprStmt).X.(*ast.CallExpr)
	recv := exprStr(call.Fun.(*ast.SelectorExpr).X)
	arg := ""
	if len(call.Args) > 0 {
		arg = exprStr(call.Args[0])
	}
	return fmt.Sprintf("%s.Add(%s)", recv, arg)
}

// esWgDone detecta wg.Done()
func esWgDone(stmt ast.Stmt) bool {
	return esSelectorCall(stmt, "Done")
}

func wgDoneDetail(stmt ast.Stmt) string {
	call := stmt.(*ast.ExprStmt).X.(*ast.CallExpr)
	recv := exprStr(call.Fun.(*ast.SelectorExpr).X)
	return fmt.Sprintf("%s.Done()", recv)
}

// esSelectorCallExpr opera directamente sobre un CallExpr (para usar con DeferStmt)
func esSelectorCallExpr(call *ast.CallExpr, method string) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	return ok && sel.Sel.Name == method
}

func esSelectorCall(stmt ast.Stmt, method string) bool {
	expr, ok := stmt.(*ast.ExprStmt)
	if !ok {
		return false
	}
	call, ok := expr.X.(*ast.CallExpr)
	if !ok {
		return false
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	return ok && sel.Sel.Name == method
}

func strLit(s string) *ast.BasicLit {
	return &ast.BasicLit{Kind: token.STRING, Value: fmt.Sprintf("%q", s)}
}

// exprStr devuelve una representación simple de una expresión para los detalles de traza.
func exprStr(e ast.Expr) string {
	switch x := e.(type) {
	case *ast.Ident:
		return x.Name
	case *ast.BasicLit:
		return x.Value
	case *ast.SelectorExpr:
		return exprStr(x.X) + "." + x.Sel.Name
	case *ast.IndexExpr:
		return exprStr(x.X) + "[" + exprStr(x.Index) + "]"
	case *ast.BinaryExpr:
		return exprStr(x.X) + x.Op.String() + exprStr(x.Y)
	case *ast.CallExpr:
		return exprStr(x.Fun) + "(...)"
	case *ast.UnaryExpr:
		return x.Op.String() + exprStr(x.X)
	default:
		return "?"
	}
}

// callDesc devuelve una descripción de la llamada para el detalle de traza.
func callDesc(call *ast.CallExpr) string {
	switch f := call.Fun.(type) {
	case *ast.Ident:
		return f.Name + "(...)"
	case *ast.SelectorExpr:
		return exprStr(f.X) + "." + f.Sel.Name + "(...)"
	case *ast.FuncLit:
		return "func(){...}"
	default:
		return "go(...)"
	}
}

// ── Código inyectado ──────────────────────────────────────────────────────

const tracerFuncs = `
var (
	__gNames   sync.Map     // goroutine ID (int64) → nombre (string)
	__gCounter atomic.Int64 // contador global para nombres únicos en runtime
)

func __gID() int64 {
	var buf [64]byte
	n := runtime.Stack(buf[:], false)
	// formato: "goroutine 42 [..."
	s := string(buf[:n])
	s = s[len("goroutine "):]
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	id := int64(0)
	for _, c := range s[:end] {
		id = id*10 + int64(c-'0')
	}
	return id
}

func __gGet() string {
	if v, ok := __gNames.Load(__gID()); ok {
		return v.(string)
	}
	return "main"
}

// __gSet asigna un nombre único a esta goroutine usando el prefijo dado.
// El número real se asigna en runtime, no en compile time.
func __gSet(prefix string) string {
	n := fmt.Sprintf("%s-%d", prefix, __gCounter.Add(1))
	__gNames.Store(__gID(), n)
	return n
}

var (
	__traceMu  sync.Mutex
	__traceOut = bufio.NewWriter(os.Stdout)
)

func __trace(event, goroutine, detail string) {
	b, _ := json.Marshal(map[string]interface{}{
		"event":     event,
		"goroutine": goroutine,
		"detail":    detail,
		"ts":        time.Now().UnixMicro(),
	})
	__traceMu.Lock()
	__traceOut.Write(b)
	__traceOut.WriteByte('\n')
	__traceOut.Flush()
	__traceMu.Unlock()
}

func __println(args ...interface{}) {
	__trace("print", __gGet(), fmt.Sprintln(args...))
}

func __printf(format string, args ...interface{}) {
	__trace("print", __gGet(), fmt.Sprintf(format, args...))
}
`

// ── ensureImports ─────────────────────────────────────────────────────────

func ensureImports(code string, required []string) string {
	missing := []string{}
	for _, pkg := range required {
		quoted := `"` + pkg + `"`
		if !strings.Contains(code, quoted) {
			missing = append(missing, "\t"+quoted)
		}
	}
	if len(missing) == 0 {
		return code
	}

	if idx := strings.Index(code, "import ("); idx != -1 {
		insertAt := idx + len("import (")
		return code[:insertAt] + "\n" + strings.Join(missing, "\n") + code[insertAt:]
	}

	if idx := strings.Index(code, "import \""); idx != -1 {
		end := strings.Index(code[idx:], "\n")
		if end == -1 {
			end = len(code[idx:])
		}
		existingLine := code[idx : idx+end]
		pkg := strings.TrimPrefix(existingLine, "import ")
		newBlock := "import (\n\t" + pkg + "\n" + strings.Join(missing, "\n") + "\n)"
		return code[:idx] + newBlock + code[idx+end:]
	}

	newBlock := "\nimport (\n" + strings.Join(missing, "\n") + "\n)\n"
	pkgEnd := strings.Index(code, "\n")
	if pkgEnd == -1 {
		return code + newBlock
	}
	return code[:pkgEnd+1] + newBlock + code[pkgEnd+1:]
}

const nativeMain = `
func main() {
	__userMain()
}`
