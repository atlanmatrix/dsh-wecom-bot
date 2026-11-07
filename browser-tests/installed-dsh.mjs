import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, realpath, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chromium } from '@playwright/test'

// A packed plugin, normal installation, and a real DSH Web profile: no symlinks or mock host.
test('installed release saves through the real browser and survives full DSH restart with digit-leading profile hashes', { timeout: 180000, skip: !process.env.DSH_CLI }, async () => {
  const repo = fileURLToPath(new URL('../', import.meta.url))
  let directory
  for (let attempt = 0; attempt < 100; attempt++) {
    directory = await mkdtemp(join(tmpdir(), 'wecom-installed-'))
    const hash = createHash('sha256').update(join(directory, 'profiles/web/wecom-bot')).digest('hex')
    if (/^[0-9]/.test(hash)) break
    await rm(directory, { recursive: true, force: true }); directory = undefined
  }
  assert.ok(directory)
  const cli = await realpath(process.env.DSH_CLI)
  const environment = { ...process.env, DSH_HOME: directory, DEEPSEEK_API_KEY: 'local-ui-test-placeholder', NPM_CONFIG_CACHE: join(directory, 'npm-cache'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_DATA_HOME: join(directory, 'data') }
  const report = { checks: [], browserErrors: [] }
  const deployment = join(directory, 'deployment.yml')
  await mkdir(join(directory, 'documents'), { recursive: true })
  await writeFile(deployment, `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(join(directory, 'documents'))}\n`)
  let processHandle, processExit, browser, context
  let artifacts
  if (process.env.DSH_TEST_ARTIFACTS) {
    await mkdir(process.env.DSH_TEST_ARTIFACTS, { recursive: true })
    artifacts = await mkdtemp(join(process.env.DSH_TEST_ARTIFACTS, 'installed-'))
  }
  async function run(command, args) {
    const child = spawn(command, args, { cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-64000) })
    const [code] = await once(child, 'exit')
    if (code !== 0) throw new Error(`Test environment setup command failed with exit code ${code}.`)
    return stdout
  }
  async function stop() {
    await context?.close(); context = undefined
    if (processHandle && processHandle.exitCode === null) {
      processHandle.kill('SIGTERM')
      const deadline = setTimeout(() => processHandle.kill('SIGKILL'), 10000)
      try { await processExit } finally { clearTimeout(deadline) }
    }
  }
  async function start() {
    processHandle = spawn(process.execPath, [cli, 'web', '--patch', deployment, '--no-open', '--port', '0'], { cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    processExit = once(processHandle, 'exit')
    const ready = Promise.withResolvers()
    let logs = ''
    const collect = data => {
      logs = (logs + data.toString()).slice(-64000)
      const url = logs.match(/dsh web: (http:\/\/[^\s]+)/)?.[1]
      if (url) ready.resolve(url)
    }
    processHandle.stdout.on('data', collect); processHandle.stderr.on('data', collect)
    processHandle.once('exit', () => ready.reject(new Error('Installed DSH failed to start; the saved credential document must remain loadable.')))
    const url = await ready.promise
    context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
    const page = await context.newPage()
    page.on('pageerror', error => report.browserErrors.push(error.message.split('\n')[0]))
    await page.goto(url)
    await page.waitForTimeout(1000)
    const notice = page.getByRole('button', { name: 'Continue', exact: true })
    if (await notice.count()) await notice.click()
    await page.waitForTimeout(1500)
    return page
  }
  async function screen(page, filename) { if (artifacts) await page.locator('.wecom-page').screenshot({ path: join(artifacts, filename) }) }
  try {
    const packed = JSON.parse(await run('npm', ['--cache', join(directory, 'npm-cache'), 'pack', '--json', '--pack-destination', directory]))
    report.pluginVersion = packed[0].version
    await run(process.execPath, [cli, 'web', '--help'])
    const profile = join(directory, 'profiles/web')
    await writeFile(join(profile, '.npmrc'), `store-dir=${join(directory, 'pnpm-store')}\ncache-dir=${join(directory, 'pnpm-cache')}\nstate-dir=${join(directory, 'pnpm-state')}\n`)
    await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', join(directory, packed[0].filename)])
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    assert.match(manifest.dependencies['dsh-wecom-bot'], /\.tgz$/)
    assert.ok(!(await realpath(join(profile, 'node_modules/dsh-wecom-bot'))).startsWith(repo))
    report.checks.push('installed the packed artifact through the official DSH CLI, independently of the source checkout')
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', args: ['--no-sandbox'] })
    let page = await start()
    if (!manifest.dsh.profile.bundles.includes('dsh-wecom-bot')) {
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      await page.getByText('Wecom Bot', { exact: true }).click()
      await page.getByRole('switch').click()
      await page.waitForTimeout(1000)
      const enabled = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
      assert.ok(enabled.dsh.profile.bundles.includes('dsh-wecom-bot'))
      await stop(); page = await start()
    }
    await page.getByRole('button', { name: 'Wecom Bot', exact: true }).click()
    await page.getByLabel('Bot ID', { exact: true }).fill('installed-test-bot')
    await page.getByLabel('Secret', { exact: true }).fill('installed-test-secret')
    await page.getByLabel('Working directory (absolute path)', { exact: true }).fill(join(directory, 'missing-directory'))
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
    const error = page.locator('.wecom-page').getByRole('alert')
    await error.filter({ hasText: 'does not exist or is not readable' }).waitFor()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    assert.match(await error.innerText(), /does not exist or is not readable/)
    await page.getByLabel('Working directory (absolute path)', { exact: true }).fill(repo)
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.getByText('Configuration saved. Click Connect when ready.', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Secret', { exact: true }).inputValue(), '')
    assert.ok(!(await page.content()).includes('installed-test-secret'))
    report.checks.push('invalid server directory is diagnosed; Retry saves the corrected configuration without exposing Secret')
    await screen(page, 'save-success.png')
    await page.getByLabel(/^Allowed user IDs /).fill('test-user-a\ntest-user-b')
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
    await page.getByText('Configuration saved. Click Connect when ready.', { exact: true }).waitFor()
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await page.getByLabel(/^Allowed user IDs /).fill('test-user-a\ntest-user-b\ntest-user-c')
      await chmod(directory, 0o500)
      try {
        await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
        await error.filter({ hasText: 'credential store' }).waitFor()
        await screen(page, 'storage-error.png')
      } finally { await chmod(directory, 0o700) }
      await page.getByRole('button', { name: 'Retry', exact: true }).click()
      await page.getByText('Configuration saved. Click Connect when ready.', { exact: true }).waitFor()
      report.checks.push('real read-only credential storage fails clearly and succeeds after permissions are restored')
    }
    const users = await page.getByLabel(/^Allowed user IDs /).inputValue()
    await stop(); page = await start()
    await page.getByRole('button', { name: 'Wecom Bot', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Disconnected' }).waitFor()
    assert.equal(await page.getByLabel('Bot ID', { exact: true }).inputValue(), 'installed-test-bot')
    assert.equal(await page.getByLabel('Secret', { exact: true }).inputValue(), '')
    assert.equal(await page.getByLabel('Secret', { exact: true }).getAttribute('placeholder'), 'Configured · leave blank to keep')
    assert.equal(await page.getByLabel(/^Allowed user IDs /).inputValue(), users)
    report.checks.push('configuration and Secret presence survived full DSH process restart on a digit-leading hash path')
    await screen(page, 'after-restart.png')
    assert.deepEqual(report.browserErrors, [])
  } finally {
    await chmod(directory, 0o700)
    await stop(); await browser?.close()
    if (artifacts) { await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2)); console.log(`Browser evidence: ${artifacts}`) }
    await rm(directory, { recursive: true, force: true })
  }
})
