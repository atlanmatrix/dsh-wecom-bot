import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, realpath, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chromium } from '@playwright/test'

// Optional full-product acceptance test. DSH is deliberately not a plugin dependency.
test('actual DSH sidebar opens Wecom Bot and reviews separate users in native transcripts', { timeout: 90000, skip: !process.env.DSH_CLI }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wecom-dsh-live-'))
  const repo = fileURLToPath(new URL('../', import.meta.url))
  const cli = await realpath(process.env.DSH_CLI)
  const requireFromDsh = createRequire(cli)
  const env = { ...process.env, DSH_HOME: directory, DEEPSEEK_API_KEY: 'local-ui-test-placeholder' }
  let child, browser, exited
  try {
    const initialize = spawn(process.execPath, [cli, 'web', '--help'], { cwd: repo, env, stdio: 'ignore' })
    assert.equal((await once(initialize, 'exit'))[0], 0)
    const modules = join(directory, 'profiles/web/node_modules')
    await mkdir(modules, { recursive: true })
    await symlink(repo, join(modules, 'dsh-wecom-bot'), 'dir')
    const fixturePath = join(directory, 'fixture.mjs')
    await writeFile(fixturePath, `
import {LlmAdapter} from ${JSON.stringify(requireFromDsh.resolve('@deepseek-ai/dsh-llm'))};
import {createAgentRunner} from ${JSON.stringify(fileURLToPath(new URL('../src/agent.js',import.meta.url)))};
export const inject=['wecomBot','agents','agentLoop','llm','workspaceRegistry','sessionTitle'];
class Adapter extends LlmAdapter {async *stream(){const text='DSH review test reply';yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};}}
export async function apply(ctx){
 ctx.llm.registerAdapter(['wecom-local-test'],new Adapter());
 const runner=createAgentRunner(ctx,{catalog:ctx.wecomBot.catalog,provider:'wecom-local-test',model:'mock',cwd:${JSON.stringify(repo)},maxSessions:10});
 ctx.on('dispose',()=>runner.close());
 for(const userId of ['review-user-a','review-user-b']){const identity={userId,groupId:'review-group-x',chatType:'group'};await runner.run(JSON.stringify(['local-test-bot',identity.chatType,identity.groupId,userId]),'Local WeCom review fixture message',new AbortController().signal,identity);}
}
`)
    const overlay = join(directory, 'overlay.yml')
    await writeFile(overlay, `- insert:\n    - id: wecom-bot\n      name: dsh-wecom-bot\n      config:\n        dataDir: ${JSON.stringify(join(directory,'bot-data'))}\n    - id: wecom-live-fixture\n      name: ${JSON.stringify(fixturePath)}\n`)
    child = spawn(process.execPath, [cli, 'web', '--patch', overlay, '--no-open', '--port', '0'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    exited = once(child, 'exit')
    const ready = Promise.withResolvers()
    let logs = ''
    const collect = data => {
      logs = (logs + data.toString()).slice(-64000)
      const url = logs.match(/dsh web: (http:\/\/[^\s]+)/)?.[1]
      if (url) ready.resolve(url)
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.once('exit', () => ready.reject(new Error('DSH test instance exited before startup.')))
    const url = await ready.promise
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text().split('\n')[0]) })
    await page.goto(url)
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 15000 })
    // Let the native default-workspace startup navigation settle before selecting a panel.
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: 'Wecom Bot', exact: true }).click()
    await page.getByLabel('Bot ID', { exact: true }).waitFor()
    await page.getByRole('status').filter({ hasText: 'Not configured' }).waitFor()
    await page.getByLabel('Bot ID', { exact: true }).fill('local-ui-bot')
    await page.getByLabel('Secret', { exact: true }).fill('local-ui-bot-secret')
    await page.getByLabel('Model provider', { exact: true }).fill('wecom-local-test')
    await page.getByLabel('Model', { exact: true }).fill('mock')
    await page.getByLabel('Working directory (absolute path)', { exact: true }).fill(repo)
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
    await page.getByText('Configuration saved. Click Connect when ready.', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Secret', { exact: true }).inputValue(), '')
    const review = page.getByRole('button', { name: 'Review in DSH', exact: true })
    await review.first().waitFor()
    assert.equal(await review.count(), 2)
    const ids = await page.locator('.wecom-sessions code').allTextContents()
    assert.equal(new Set(ids).size, 2)
    await review.first().click()
    await page.getByText('Local WeCom review fixture message', { exact: true }).waitFor()
    await page.getByText('DSH review test reply', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10000)
      try { await exited } finally { clearTimeout(deadline) }
    }
    await rm(directory, { recursive: true, force: true })
  }
})
