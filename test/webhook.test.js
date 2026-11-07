import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createClient, createPayload, validateWebhook } from '../src/client.js'
const webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key'

test('validates UTF-8 size, message types, and text-only mentions', () => {
  assert.deepEqual(createPayload({ content: '你好', mentioned_list: ['@all', '@all'] }), { msgtype: 'text', text: { content: '你好', mentioned_list: ['@all'] } })
  assert.throws(() => createPayload({ content: '中'.repeat(683) }), /UTF-8/)
  assert.throws(() => createPayload({ content: 'x', msgtype: 'markdown', mentioned_list: [] }), /only/)
  assert.throws(() => createPayload({ content: '', unknown: true }))
  assert.throws(() => validateWebhook('https://example.com?key=SECRET'))
})
test('posts correct JSON through a local HTTP test endpoint', async () => {
  let received
  const server = http.createServer(async (req, res) => {
    received = { method: req.method, body: JSON.parse(await Array.fromAsync(req).then(chunks => Buffer.concat(chunks).toString())) }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const client = createClient({ webhook, fetchImpl: (_endpoint, options) => fetch(`http://127.0.0.1:${server.address().port}`, options) })
    assert.deepEqual(await client.send({ content: '**测试**', msgtype: 'markdown' }), { delivered: true, msgtype: 'markdown' })
    assert.equal(received.method, 'POST')
    assert.deepEqual(received.body, { msgtype: 'markdown', markdown: { content: '**测试**' } })
  } finally { await new Promise(resolve => server.close(resolve)) }
})
test('sanitizes transport and remote failures without retrying', async () => {
  for (const response of [new Response('secret', { status: 500 }), Response.json({ errcode: 93000, errmsg: 'SECRET' }), new Response('invalid')]) {
    let count = 0
    const client = createClient({ webhook, fetchImpl: async () => { count++; return response } })
    await assert.rejects(client.send({ content: 'x' }), error => !error.message.includes('SECRET') && !error.message.includes('test-key'))
    assert.equal(count, 1)
  }
})
