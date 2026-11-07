import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { Context } from '@deepseek-ai/cordis'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { WecomBotController } from '../src/controller.js'
import { SessionCatalog } from '../src/catalog.js'
import { remoteContribution } from '../src/remote.js'

test('bundled client: menu registration, configuration RPC, Secret redaction, review navigation, and mobile layout', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wecom-browser-'))
  const ctx = new Context()
  let browser, server, controller
  try {
    await ctx.plugin(Credentials, { path: join(directory, '.credentials.yaml'), watch: false })
    await ctx.plugin(TypertRegistry); await ctx.plugin(RemoteAccess); await ctx.plugin(Gateway)
    ctx.typert.register({ package: 'dsh-wecom-bot', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: remoteContribution.descriptors })
    const catalog = new SessionCatalog(join(directory, 'sessions.json')); await catalog.load()
    await catalog.put({ key: 'one', sessionId: 'wecom-review-one', title: 'Wecom · user1 · group1', userId: 'user1', groupId: 'group1', chatType: 'group', updatedAt: Date.now() })
    controller = new WecomBotController(ctx, { catalog, credentialKey: 'wecom-bot/browser', start: async (_config, status) => ({ start() { status('connected') }, async close() {} }) })
    await controller.initialize()
    const owner = new Peer(ctx, { principal: { kind: 'owner' } })
    const fixture = await build({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
window.__ModuleLoader__={load(registration){window.registration=registration}};
await import('./dist/client.js');
const plugin=window.registration.factory(name=>{if(name==='react')return React;throw Error(name)});
const entries=new Map();let dictionaries;
const api=Object.fromEntries(['state','configure','connect','disconnect'].map(method=>[method,async request=>{const r=await fetch('/rpc/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(method==='configure'?{request}:{})});return r.json()}]));
const ctx={inject(names,fn){return fn(this)},effect(fn){return fn()},locale:{register(ns,dict){dictionaries=dict}},remote:{$mount:async()=>{},wecomBot:api},uiWorkspace:{openSession(id){window.reviewedSession=id}},slots:{inject(name,fn){return fn()},register(options,Component){entries.set(options.name,{options,Component})}}};
await plugin.apply(ctx);
const menu=entries.get('sidebar.panellist');window.menuRegistration={id:menu.options.id,label:menu.options.label};
const page=entries.get('main');const t=key=>dictionaries.zh[key];
createRoot(document.getElementById('app')).render(React.createElement(page.Component,{...page.options.inject(),t}));
`, resolveDir: process.cwd(), sourcefile: 'browser-fixture.js' }, bundle: true, format: 'esm', platform: 'browser', write: false })
    server = http.createServer(async (req, res) => {
      try {
        if (req.url === '/app.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(fixture.outputFiles[0].text); return }
        if (req.url.startsWith('/rpc/')) {
          const args = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString() || '{}')
          const value = await ctx.typertGateway.invoke({ namespace: 'wecomBot', method: req.url.slice(5), args, peer: owner })
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, value })); return
        }
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{height:100%;margin:0;font:14px system-ui}</style><div id="app"></div><script type="module" src="/app.js"></script></html>')
      } catch { res.end(JSON.stringify({ ok: false })) }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1100, height: 960 } })
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('status').filter({ hasText: '未配置' }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.menuRegistration), { id: 'wecom-bot', label: 'Wecom Bot' })
    await page.getByLabel('Bot ID', { exact: true }).fill('browser-bot')
    await page.getByLabel('Secret', { exact: true }).fill('browser-private-secret')
    await page.getByLabel('工作目录（绝对路径）', { exact: true }).fill(directory)
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await page.getByText('配置已保存，请点击连接机器人。', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Secret', { exact: true }).inputValue(), '')
    assert.ok(!(await page.content()).includes('browser-private-secret'))
    await page.getByRole('button', { name: '连接机器人', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '已连接' }).waitFor()
    await page.getByRole('button', { name: '在 DSH 中 review', exact: true }).click()
    assert.equal(await page.evaluate(() => window.reviewedSession), 'wecom-review-one')
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: '/tmp/wecom-bot-mobile.png', fullPage: true })
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve))
    await controller?.close(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true })
  }
})
