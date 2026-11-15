;; Asyncify: o mesmo teste do jspi.wat, mas o build passa este módulo pelo "asyncify" do binaryen,
;; que reescreve o código para salvar e restaurar a pilha na memória ao esperar "sleep".
(module
  (import "env" "sleep" (func $sleep (result i32)))
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    call $sleep
    i32.const 1
    i32.add))
