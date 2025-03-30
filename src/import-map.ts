import { computed, version as currentVersion, ref } from 'vue'

export function useVueImportMap(
  defaults: {
    runtimeDev?: string | (() => string)
    runtimeProd?: string | (() => string)
    serverRenderer?: string | (() => string)
    vueVersion?: string | null
  } = {},
) {
  function normalizeDefaults(defaults?: string | (() => string)) {
    if (!defaults) return
    return typeof defaults === 'string' ? defaults : defaults()
  }

  let productionMode = ref(false)
  let vueVersion = ref<string | null>(defaults.vueVersion || null)
  let importMap = computed<ImportMap>(() => {
    let vue =
      (!vueVersion.value &&
        normalizeDefaults(
          productionMode.value ? defaults.runtimeProd : defaults.runtimeDev,
        )) ||
      `https://cdn.jsdelivr.net/npm/@vue/runtime-dom@${
        vueVersion.value || currentVersion
      }/dist/runtime-dom.esm-browser${productionMode.value ? `.prod` : ``}.js`

    let serverRenderer =
      (!vueVersion.value && normalizeDefaults(defaults.serverRenderer)) ||
      `https://cdn.jsdelivr.net/npm/@vue/server-renderer@${
        vueVersion.value || currentVersion
      }/dist/server-renderer.esm-browser.js`
    return {
      imports: {
        vue,
        'vue/server-renderer': serverRenderer,
      },
    }
  })

  return {
    productionMode,
    importMap,
    vueVersion,
    defaultVersion: currentVersion,
  }
}

export interface ImportMap {
  imports?: Record<string, string | undefined>
  scopes?: Record<string, Record<string, string>>
}

export function mergeImportMap(a: ImportMap, b: ImportMap): ImportMap {
  return {
    imports: { ...a.imports, ...b.imports },
    scopes: { ...a.scopes, ...b.scopes },
  }
}
