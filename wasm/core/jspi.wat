;; JSPI: "run" chama "getv", que no JavaScript é assíncrona. Com JSPI o WebAssembly pausa, espera a
;; Promise e retoma com o valor. Resultado esperado: valor + 1.
(module
  (import "env" "getv" (func $getv (result i32)))
  (func (export "run") (result i32)
    call $getv
    i32.const 1
    i32.add))
