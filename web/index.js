import React from 'react'
import { Panel, dictionaries } from './panel.js'
import { remoteContribution } from '../src/remote.js'
const h = React.createElement
export const inject = ['slots', 'locale', 'remote', 'uiWorkspace']
const id = 'wecom-bot'
function Icon() {
  return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
    h('path', { d: 'M4 4h16v12H10l-5 4v-4H4z' }), h('path', { d: 'm9 8-2 2 2 2m6-4 2 2-2 2' }))
}
export async function apply(ctx) {
  ctx.effect(() => ctx.locale.register('wecom.bot', dictionaries), 'wecom-bot: translations')
  await ctx.remote.$mount(remoteContribution)
  await ctx.inject(['remote.wecomBot'], scope => {
    scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: id, locale: 'wecom.bot',
      inject: () => ({ api: scope.remote.wecomBot, openSession: sessionId => scope.uiWorkspace.openSession(sessionId) }),
    }, Panel))
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id, order: 15, label: 'Wecom Bot' }, Icon))
  })
}
