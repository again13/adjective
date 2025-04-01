/// <reference types="vite/client" />

declare module '*.vue' {
  import type { ComponentOptions } from 'vue'
  let comp: ComponentOptions
  export default comp
}
