import { build } from 'esbuild'
await build({ entryPoints: ['web/index.js'], outfile: 'dist/client.js', bundle: true, minify: true, format: 'cjs', platform: 'browser', target: 'es2022', external: ['react'],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-wecom-bot",factory(require){const module={exports:{}};const exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
})
