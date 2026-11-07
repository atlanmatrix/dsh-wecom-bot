import React, { useEffect, useRef, useState } from 'react'
const h = React.createElement
export const dictionaries = {
  en: { title: 'Wecom Bot', intro: 'Connect a WeCom AI bot and review its conversations in Harness.', botId: 'Bot ID', secret: 'Secret', configured: 'Configured · leave blank to keep', provider: 'Model provider', model: 'Model', cwd: 'Working directory (absolute path)', users: 'Allowed user IDs (one per line; empty allows all bot contacts)', save: 'Save configuration', connect: 'Connect', disconnect: 'Disconnect', sessions: 'Conversations', empty: 'No conversations yet. Connect your bot, then send it a text message in WeCom.', review: 'Review in DSH', user: 'User', group: 'Group', single: 'Direct message', loading: 'Loading…', retry: 'Retry', error: 'The operation failed. Check the configuration and try again.', saved: 'Configuration saved. Click Connect when ready.', unconfigured: 'Not configured', disconnected: 'Disconnected', connecting: 'Connecting', connected: 'Connected', connectionError: 'Connection error', hint: 'The Secret is stored by Harness and is never returned to this page. Messages use the tools and permissions of this Harness profile.', refresh: 'Refresh', unsaved: 'Save changes before connecting.' },
  zh: { title: 'Wecom Bot', intro: '连接企业微信智能机器人，并在 Harness 中查看和 review 对话。', botId: 'Bot ID', secret: 'Secret', configured: '已配置，留空保持不变', provider: '模型 Provider', model: '模型', cwd: '工作目录（绝对路径）', users: '允许的用户 ID（每行一个；留空允许所有机器人联系人）', save: '保存配置', connect: '连接机器人', disconnect: '断开连接', sessions: '机器人对话', empty: '暂无对话。连接机器人后，在企业微信中发送文本消息。', review: '在 DSH 中 review', user: '用户', group: '群组', single: '单聊', loading: '加载中…', retry: '重试', error: '操作失败，请检查配置后重试。', saved: '配置已保存，请点击连接机器人。', unconfigured: '未配置', disconnected: '未连接', connecting: '连接中', connected: '已连接', connectionError: '连接错误', hint: 'Secret 由 Harness 凭据服务保存，不会回传到此页面。机器人使用当前 profile 的工具和权限。', refresh: '刷新', unsaved: '请先保存配置，再连接机器人。' },
}
const blank = { botId: '', secret: '', provider: 'deepseek', model: 'deepseek-chat', cwd: '', allowedUsers: '' }
export function Panel({ t, api, openSession }) {
  const [snapshot, setSnapshot] = useState(null)
  const [fields, setFields] = useState(blank)
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [notice, setNotice] = useState('')
  const [dirty, setDirty] = useState(false)
  const mounted = useRef(false), initialized = useRef(false)
  const accept = (value, replace = false) => {
    if (!mounted.current) return
    setSnapshot(value)
    if (!initialized.current || replace) {
      const config = value.configuration
      setFields(config ? { ...config, secret: '', allowedUsers: config.allowedUsers.join('\n') } : blank)
      initialized.current = true
      setDirty(false)
    }
  }
  const refresh = async () => {
    try { const result = await api.state(); if (!result.ok) throw new Error(); accept(result.value); if (mounted.current) setError(false) }
    catch { if (mounted.current) setError(true) }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 3000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [])
  const action = async (method, request) => {
    setBusy(true); setError(false); setNotice('')
    try {
      const result = await api[method](...(request ? [request] : []))
      if (!result.ok) throw new Error()
      accept(result.value, method === 'configure')
      if (mounted.current && method === 'configure') setNotice(t('saved'))
    } catch { if (mounted.current) setError(true) }
    finally { if (mounted.current) setBusy(false) }
  }
  const field = (key, type = 'text') => h('label', { key }, t(key), h('input', {
    name: key, type, value: fields[key], required: key !== 'secret' || !snapshot?.configuration?.secretConfigured,
    placeholder: key === 'secret' && snapshot?.configuration?.secretConfigured ? t('configured') : '',
    autoComplete: key === 'secret' ? 'new-password' : 'off',
    onChange: event => { setFields(previous => ({ ...previous, [key]: event.target.value })); setDirty(true) },
  }))
  const status = snapshot?.status === 'error' ? 'connectionError' : snapshot?.status
  return h('section', { className: 'wecom-page', 'aria-label': t('title') },
    h('style', null, styles),
    h('div', { className: 'wecom-content' },
      h('header', null, h('h1', null, t('title')), h('span', { role: 'status', className: 'wecom-status' }, status ? t(status) : t('loading'))),
      h('p', null, t('intro')),
      error && h('div', { role: 'alert' }, t('error'), ' ', h('button', { type: 'button', disabled: busy, onClick: refresh }, t('retry'))),
      notice && h('p', { role: 'status' }, notice),
      h('form', { onSubmit: event => {
        event.preventDefault()
        const { secret, allowedUsers, ...values } = fields
        delete values.secretConfigured
        void action('configure', { ...values, ...(secret ? { secret } : {}), allowedUsers: allowedUsers.split(/\n|,/).map(id => id.trim()).filter(Boolean) })
      } },
        h('fieldset', { disabled: busy || !snapshot },
          h('div', { className: 'wecom-grid' }, field('botId'), field('secret', 'password'), field('provider'), field('model')),
          field('cwd'),
          h('label', null, t('users'), h('textarea', { name: 'allowedUsers', rows: 3, value: fields.allowedUsers, onChange: event => { setFields(previous => ({ ...previous, allowedUsers: event.target.value })); setDirty(true) } })),
          h('p', { className: 'wecom-hint' }, t('hint')),
          h('div', { className: 'wecom-actions' },
            h('button', { type: 'submit' }, t('save')),
            h('button', { type: 'button', disabled: dirty || !snapshot?.configuration || snapshot?.status === 'connecting' || snapshot?.status === 'connected', onClick: () => action('connect') }, t('connect')),
            h('button', { type: 'button', disabled: !snapshot?.configuration, onClick: () => action('disconnect') }, t('disconnect'))),
          dirty && h('p', { className: 'wecom-hint' }, t('unsaved')))),
      h('div', { className: 'wecom-heading' }, h('h2', null, t('sessions')), h('button', { type: 'button', onClick: refresh, disabled: busy }, t('refresh'))),
      !snapshot?.sessions.length ? h('p', null, t('empty')) : h('ul', { className: 'wecom-sessions' }, snapshot.sessions.map(row =>
        h('li', { key: row.sessionId },
          h('div', null, h('strong', null, row.title), h('p', null, `${t('user')}: ${row.userId} · ${row.chatType === 'group' ? `${t('group')}: ${row.groupId}` : t('single')}`), h('code', null, row.sessionId)),
          h('button', { type: 'button', onClick: () => openSession(row.sessionId) }, t('review'))))))
  )
}
const styles = `
.wecom-page{height:100%;min-width:0;overflow:auto;box-sizing:border-box;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-base,transparent);font-size:14px;line-height:1.6;font-family:inherit}
.wecom-content{max-width:960px;margin:auto;padding:28px clamp(20px,4vw,48px) 48px;padding-top:max(28px,var(--dsh-frame-leading-clearance,28px))}
.wecom-page header,.wecom-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.wecom-page h1{font-size:26px;margin:0}.wecom-page h2{font-size:19px;margin:0}.wecom-status{border:1px solid currentColor;border-radius:20px;padding:2px 12px}
.wecom-page fieldset{border:0;margin:24px 0;padding:0;min-width:0}.wecom-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px}.wecom-page label{display:grid;gap:6px;margin-bottom:16px}.wecom-page input,.wecom-page textarea{box-sizing:border-box;width:100%;min-width:0;padding:9px 12px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-primary,#8888);border-radius:8px}.wecom-page input:focus-visible,.wecom-page textarea:focus-visible,.wecom-page button:focus-visible{outline:2px solid var(--dsw-alias-label-link,#1681ed);outline-offset:3px}.wecom-page button{padding:8px 14px;border:1px solid var(--dsw-alias-border-primary,#8888);background:var(--dsw-alias-bg-base,transparent);color:inherit;border-radius:8px;font:inherit;cursor:pointer}.wecom-page button:disabled{opacity:.5;cursor:default}.wecom-actions{display:flex;gap:10px;flex-wrap:wrap}.wecom-hint{color:var(--dsw-alias-label-secondary,inherit);font-size:13px}.wecom-page [role=alert]{padding:12px;border:1px solid #c44;border-radius:8px}.wecom-sessions{padding:0;list-style:none}.wecom-sessions li{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-primary,#8888)}.wecom-sessions p{margin:4px 0}.wecom-sessions code{font-size:12px;overflow-wrap:anywhere}.wecom-sessions li>div{min-width:0;overflow-wrap:anywhere}.wecom-sessions button{flex-shrink:0}@media(max-width:600px){.wecom-grid{grid-template-columns:1fr}.wecom-sessions li{align-items:start;flex-direction:column}}
`
