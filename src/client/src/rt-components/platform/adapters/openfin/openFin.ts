import { BasePlatformAdapter } from '../platformAdapter'
import { AppConfig, WindowConfig, InteropTopics, ExcelInterop } from '../types'
import { openDesktopWindow } from './window'
import { fromEventPattern } from 'rxjs'
import { excelAdapter } from './excel'
import { CurrencyPairPositionWithPrice } from 'rt-types'
import { LayoutActions } from '../../../../shell/layouts/layoutActions'

export async function setupWorkspaces(store: any) {
  if (typeof fin !== 'undefined') {
    const workspaces = require('openfin-layouts').workspaces
    await workspaces.setRestoreHandler((workspace: any) => appRestoreHandler(workspace, store))
    await workspaces.ready()
  }
}

export const openFinNotifications: any[] = []

declare const window: Window & { onNotificationMessage: any }

export const setupGlobalOpenfinNotifications = () => {
  if (typeof fin !== 'undefined' && !window.onNotificationMessage) {
    // openfin requires a global onNotificationMessage function to be defined before its notification structure is initialized in the platform adapter.
    // NotificationRoute is imported lazily, thus we cannot define the function in that file. (Testing has shown it's already too late.)
    // - D.S.
    window.onNotificationMessage = (message: any) => openFinNotifications.push(message)
  }
}

type OpenFinWindowState = Parameters<Parameters<fin.OpenFinWindow['getState']>[0]>[0]
export default class OpenFin extends BasePlatformAdapter {
  readonly name = 'openfin'
  readonly type = 'desktop'

  notificationHighlight = {
    init: () => this.interop.subscribe$(InteropTopics.HighlightBlotter),
  }

  chartIQ = {
    open: (id: string, config: AppConfig) => this.app.open(id, config),
  }

  window = {
    close: () => fin.desktop.Window.getCurrent().close(),

    open: (config: WindowConfig, onClose?: () => void) => openDesktopWindow(config, onClose),

    maximize: () => {
      const win = fin.desktop.Window.getCurrent()
      win.getState((state: OpenFinWindowState) => {
        switch (state) {
          case 'maximized':
          case 'minimized':
            win.restore(() => win.bringToFront())
            break
          case 'normal':
          default:
            win.maximize()
            break
        }
      })
    },

    minimize: () => fin.desktop.Window.getCurrent().minimize(),
  }

  app = {
    exit: () => fin.desktop.Application.getCurrent().close(),
    open: (id: string, config: AppConfig) =>
      new Promise<string>((resolve, reject) => {
        fin.desktop.System.getAllApplications(apps => {
          const isRunning = apps.find(app => app.isRunning && app.uuid === id)
          if (isRunning) {
            // tslint:disable-next-line:no-unused-expression
            config.payload && this.interop.publish(config.topic, config.payload)
          } else {
            const appConfig = {
              name: config.uuid,
              uuid: config.uuid,
              url: config.url,
              mainWindowOptions: {
                icon: config.icon,
                autoShow: true,
                frame: true,
              },
            }
            const app: fin.OpenFinApplication = new fin.desktop.Application(
              appConfig,
              () => app.run(() => setTimeout(() => resolve(id), 1000), err => reject(err)),
              err => reject(err),
            )
          }
        })
      }),
  }

  interop = {
    subscribe$: (topic: string) =>
      fromEventPattern(
        (handler: Function) =>
          fin.desktop.InterApplicationBus.subscribe('*', topic, handler as () => void),
        (handler: Function) =>
          fin.desktop.InterApplicationBus.unsubscribe('*', topic, handler as () => void),
      ),

    publish: (topic: string, message: string | object) =>
      fin.desktop.InterApplicationBus.publish(topic, message),
  }

  excel: ExcelInterop = {
    adapterName: excelAdapter.name,
    open: () => excelAdapter.openExcel(),
    isOpen: () => excelAdapter.isSpreadsheetOpen(),
    publishPositions: (positions: CurrencyPairPositionWithPrice[]) =>
      excelAdapter.publishPositions(positions),
    publishBlotter: <T extends any>(blotterData: T) => excelAdapter.publishBlotter(blotterData),
  }

  notification = {
    notify: (message: object) =>
      new fin.desktop.Notification({
        url: '/notification',
        message,
        timeout: 8000,
      } as any),
  }
}

async function appRestoreHandler(workspaceApp: any, store: any) {
  const ofApp = await fin.Application.getCurrent()
  const openWindows = await ofApp.getChildWindows()

  const opened = workspaceApp.childWindows.map(async (win: any, index: any) => {
    if (!openWindows.some(w => w.identity.name === win.name)) {
      const config: WindowConfig = {
        name: win.name,
        url: win.url,
        width: win.bounds.width,
        height: win.bounds.height,
      }
      await openDesktopWindow(
        config,
        () => {
          store.dispatch(
            LayoutActions.updateContainerVisibilityAction({
              name: win.name,
              display: true,
            }),
          )
        },
        { defaultLeft: win.bounds.left, defaultTop: win.bounds.top },
      )

      // we need to 'remove' the child window from the main window
      store.dispatch(
        LayoutActions.updateContainerVisibilityAction({
          name: win.name,
          display: false,
        }),
      )
    } else {
      await positionWindow(win)
    }
  })

  await Promise.all(opened)
  return workspaceApp
}

async function positionWindow(win: any): Promise<void> {
  console.error('dans positionWindow', win)
  try {
    const { isShowing, isTabbed } = win

    const ofWin = await fin.Window.wrap(win)
    await ofWin.setBounds(win.bounds)

    if (isTabbed) {
      await ofWin.show()
      return
    }

    await ofWin.leaveGroup()

    if (isShowing) {
      if (win.state === 'normal') {
        // Need to both restore and show because the restore function doesn't emit a `shown` or `show-requested` event
        await ofWin.restore()
        await ofWin.show()
      } else if (win.state === 'minimized') {
        await ofWin.minimize()
      } else if (win.state === 'maximized') {
        await ofWin.maximize()
      }
    } else {
      await ofWin.hide()
    }
  } catch (e) {
    console.error('position window error', e)
  }
}
