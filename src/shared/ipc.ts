// IPC channel names. Renderer-facing surface is exposed via the chrome preload
// as window.wumpiary (see src/preload/chrome.ts) — the renderer never touches
// ipcRenderer directly.

export const IPC = {
  // renderer -> main (invoke / request-response)
  getState: 'app:getState',
  setupPin: 'vault:setup',
  unlock: 'vault:unlock',
  lock: 'app:lock',
  addAccount: 'accounts:add',
  signOut: 'accounts:signout',
  forget: 'accounts:forget',
  reorder: 'accounts:reorder',
  setActive: 'accounts:setActive',
  setHibernated: 'accounts:hibernate',
  reload: 'accounts:reload',
  openDevtools: 'accounts:devtools',
  updateAccount: 'accounts:update',
  snooze: 'accounts:snooze',
  patchUi: 'settings:patchUi',
  patchGlobal: 'settings:patchGlobal',
  setOverlay: 'ui:setOverlay', // hide account views while a full-window modal is open
  clearActivity: 'activity:clear',

  // main -> renderer (events)
  stateChanged: 'app:stateChanged',
  playChime: 'app:playChime',

  // account-observer preload -> main
  obMetrics: 'observer:metrics',
  obNotification: 'observer:notification',
  obConnection: 'observer:connection',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
