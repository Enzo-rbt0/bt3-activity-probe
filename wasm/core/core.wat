;; Módulo de teste próprio (não tem nada de jogo).
;; add: confere que o WebAssembly calcula certo. bench: conta informativa para comparar com JavaScript.
(module
  (func (export "add") (param i32 i32) (result i32)
    local.get 0
    local.get 1
    i32.add)
  (func (export "bench") (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (block $fim
      (loop $volta
        local.get $i
        local.get $n
        i32.ge_u
        br_if $fim
        local.get $acc
        local.get $i
        local.get $i
        i32.mul
        i32.add
        i32.const 7
        i32.xor
        local.set $acc
        local.get $i
        i32.const 1
        i32.add
        local.set $i
        br $volta))
    local.get $acc))
