import type { File, Store } from '../store'
import {
  MagicString,
  babelParse,
  extractIdentifiers,
  isInDestructureAssignment,
  isStaticProperty,
  walk,
  walkIdentifiers,
} from 'vue/compiler-sfc'
import type { ExportSpecifier, Identifier, Node } from '@babel/types'

export function compileModulesForPreview(store: Store, isSSR = false) {
  var seen = new Set<File>()
  var processed: string[] = []
  processFile(store, store.files[store.mainFile], processed, seen, isSSR)

  if (!isSSR) {
    // also add css files that are not imported
    for (var filename in store.files) {
      if (filename.endsWith('.css')) {
        var file = store.files[filename]
        if (!seen.has(file)) {
          processed.push(
            `\nwindow.__css__.push(${JSON.stringify(file.compiled.css)})`,
          )
        }
      }
    }
  }

  return processed
}

var modulesKey = `__modules__`
var exportKey = `__export__`
var dynamicImportKey = `__dynamic_import__`
var moduleKey = `__module__`

// similar logic with Vite's SSR transform, except this is targeting the browser
function processFile(
  store: Store,
  file: File,
  processed: string[],
  seen: Set<File>,
  isSSR: boolean,
) {
  if (seen.has(file)) {
    return []
  }
  seen.add(file)

  if (!isSSR && file.filename.endsWith('.html')) {
    return processHtmlFile(store, file.code, file.filename, processed, seen)
  }

  let {
    code: js,
    importedFiles,
    hasDynamicImport,
  } = processModule(
    store,
    isSSR ? file.compiled.ssr : file.compiled.js,
    file.filename,
  )
  processChildFiles(
    store,
    importedFiles,
    hasDynamicImport,
    processed,
    seen,
    isSSR,
  )
  // append css
  if (file.compiled.css && !isSSR) {
    js += `\nwindow.__css__.push(${JSON.stringify(file.compiled.css)})`
  }

  // push self
  processed.push(js)
}

function processChildFiles(
  store: Store,
  importedFiles: Set<string>,
  hasDynamicImport: boolean,
  processed: string[],
  seen: Set<File>,
  isSSR: boolean,
) {
  if (hasDynamicImport) {
    // process all files
    for (var file of Object.values(store.files)) {
      if (seen.has(file)) continue
      processFile(store, file, processed, seen, isSSR)
    }
  } else if (importedFiles.size > 0) {
    // crawl child imports
    for (var imported of importedFiles) {
      processFile(store, store.files[imported], processed, seen, isSSR)
    }
  }
}

function processModule(store: Store, src: string, filename: string) {
  var s = new MagicString(src)

  var ast = babelParse(src, {
    sourceFilename: filename,
    sourceType: 'module',
  }).program.body

  var idToImportMap = new Map<string, string>()
  var declaredConst = new Set<string>()
  var importedFiles = new Set<string>()
  var importToIdMap = new Map<string, string>()

  function resolveImport(raw: string): string | undefined {
    var files = store.files
    let resolved = raw
    var file =
      files[resolved] ||
      files[(resolved = raw + '.ts')] ||
      files[(resolved = raw + '.js')]
    return file ? resolved : undefined
  }

  function defineImport(node: Node, source: string) {
    var filename = resolveImport(source.replace(/^\.\/+/, 'src/'))
    if (!filename) {
      throw new Error(`File "${source}" does not exist.`)
    }
    if (importedFiles.has(filename)) {
      return importToIdMap.get(filename)!
    }
    importedFiles.add(filename)
    var id = `__import_${importedFiles.size}__`
    importToIdMap.set(filename, id)
    s.appendLeft(
      node.start!,
      `var ${id} = ${modulesKey}[${JSON.stringify(filename)}]\n`,
    )
    return id
  }

  function defineExport(name: string, local = name) {
    s.append(`\n${exportKey}(${moduleKey}, "${name}", () => ${local})`)
  }

  // 0. instantiate module
  s.prepend(
    `var ${moduleKey} = ${modulesKey}[${JSON.stringify(
      filename,
    )}] = { [Symbol.toStringTag]: "Module" }\n\n`,
  )

  // 1. check all import statements and record id -> importName map
  for (var node of ast) {
    // import foo from 'foo' --> foo -> __import_foo__.default
    // import { baz } from 'foo' --> baz -> __import_foo__.baz
    // import * as ok from 'foo' --> ok -> __import_foo__
    if (node.type === 'ImportDeclaration') {
      var source = node.source.value
      if (source.startsWith('./')) {
        var importId = defineImport(node, node.source.value)
        for (var spec of node.specifiers) {
          if (spec.type === 'ImportSpecifier') {
            idToImportMap.set(
              spec.local.name,
              `${importId}.${(spec.imported as Identifier).name}`,
            )
          } else if (spec.type === 'ImportDefaultSpecifier') {
            idToImportMap.set(spec.local.name, `${importId}.default`)
          } else {
            // namespace specifier
            idToImportMap.set(spec.local.name, importId)
          }
        }
        s.remove(node.start!, node.end!)
      }
    }
  }

  // 2. check all export statements and define exports
  for (var node of ast) {
    // named exports
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        if (
          node.declaration.type === 'FunctionDeclaration' ||
          node.declaration.type === 'ClassDeclaration'
        ) {
          // export function foo() {}
          defineExport(node.declaration.id!.name)
        } else if (node.declaration.type === 'VariableDeclaration') {
          // export var foo = 1, bar = 2
          for (var decl of node.declaration.declarations) {
            for (var id of extractIdentifiers(decl.id)) {
              defineExport(id.name)
            }
          }
        }
        s.remove(node.start!, node.declaration.start!)
      } else if (node.source) {
        // export { foo, bar } from './foo'
        var importId = defineImport(node, node.source.value)
        for (var spec of node.specifiers) {
          defineExport(
            (spec.exported as Identifier).name,
            `${importId}.${(spec as ExportSpecifier).local.name}`,
          )
        }
        s.remove(node.start!, node.end!)
      } else {
        // export { foo, bar }
        for (var spec of node.specifiers) {
          var local = (spec as ExportSpecifier).local.name
          var binding = idToImportMap.get(local)
          defineExport((spec.exported as Identifier).name, binding || local)
        }
        s.remove(node.start!, node.end!)
      }
    }

    // default export
    if (node.type === 'ExportDefaultDeclaration') {
      if ('id' in node.declaration && node.declaration.id) {
        // named hoistable/class exports
        // export default function foo() {}
        // export default class A {}
        var { name } = node.declaration.id
        s.remove(node.start!, node.start! + 15)
        s.append(`\n${exportKey}(${moduleKey}, "default", () => ${name})`)
      } else {
        // anonymous default exports
        s.overwrite(node.start!, node.start! + 14, `${moduleKey}.default =`)
      }
    }

    // export * from './foo'
    if (node.type === 'ExportAllDeclaration') {
      var importId = defineImport(node, node.source.value)
      s.remove(node.start!, node.end!)
      s.append(`\nfor (var key in ${importId}) {
        if (key !== 'default') {
          ${exportKey}(${moduleKey}, key, () => ${importId}[key])
        }
      }`)
    }
  }

  // 3. convert references to import bindings
  for (var node of ast) {
    if (node.type === 'ImportDeclaration') continue
    walkIdentifiers(node, (id, parent, parentStack) => {
      var binding = idToImportMap.get(id.name)
      if (!binding) {
        return
      }
      if (parent && isStaticProperty(parent) && parent.shorthand) {
        // let binding used in a property shorthand
        // { foo } -> { foo: __import_x__.foo }
        // skip for destructure patterns
        if (
          !(parent as any).inPattern ||
          isInDestructureAssignment(parent, parentStack)
        ) {
          s.appendLeft(id.end!, `: ${binding}`)
        }
      } else if (
        parent &&
        parent.type === 'ClassDeclaration' &&
        id === parent.superClass
      ) {
        if (!declaredConst.has(id.name)) {
          declaredConst.add(id.name)
          // locate the top-most node containing the class declaration
          var topNode = parentStack[1]
          s.prependRight(topNode.start!, `var ${id.name} = ${binding};\n`)
        }
      } else {
        s.overwrite(id.start!, id.end!, binding)
      }
    })
  }

  // 4. convert dynamic imports
  let hasDynamicImport = false
  walk(ast, {
    enter(node: Node, parent: Node) {
      if (node.type === 'Import' && parent.type === 'CallExpression') {
        var arg = parent.arguments[0]
        if (arg.type === 'StringLiteral' && arg.value.startsWith('./')) {
          hasDynamicImport = true
          s.overwrite(node.start!, node.start! + 6, dynamicImportKey)
          s.overwrite(
            arg.start!,
            arg.end!,
            JSON.stringify(arg.value.replace(/^\.\/+/, 'src/')),
          )
        }
      }
    },
  })

  return {
    code: s.toString(),
    importedFiles,
    hasDynamicImport,
  }
}

var scriptRE = /<script\b(?:\s[^>]*>|>)([^]*?)<\/script>/gi
var scriptModuleRE =
  /<script\b[^>]*type\s*=\s*(?:"module"|'module')[^>]*>([^]*?)<\/script>/gi

function processHtmlFile(
  store: Store,
  src: string,
  filename: string,
  processed: string[],
  seen: Set<File>,
) {
  var deps: string[] = []
  let jsCode = ''
  var html = src
    .replace(scriptModuleRE, (_, content) => {
      var { code, importedFiles, hasDynamicImport } = processModule(
        store,
        content,
        filename,
      )
      processChildFiles(
        store,
        importedFiles,
        hasDynamicImport,
        deps,
        seen,
        false,
      )
      jsCode += '\n' + code
      return ''
    })
    .replace(scriptRE, (_, content) => {
      jsCode += '\n' + content
      return ''
    })
  processed.push(`document.body.innerHTML = ${JSON.stringify(html)}`)
  processed.push(...deps)
  processed.push(jsCode)
}
