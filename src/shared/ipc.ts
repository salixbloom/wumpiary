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
  showAccountMenu: 'accounts:showMenu', // pop the native per-account right-click menu
  pickSource: 'screenshare:pickSource', // renderer -> main: chosen screen/window for Go Live (null = cancel)
  patchUi: 'settings:patchUi',
  patchGlobal: 'settings:patchGlobal',
  layoutSidebar: 'ui:layoutSidebar', // renderer drives the live sidebar width each frame so native views track the collapse/expand animation (null = settle to configured width)
  setOverlay: 'ui:setOverlay', // hide account views while a full-window modal is open
  setWindowBackground: 'ui:setWindowBackground',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  clearActivity: 'activity:clear',
  setLocale: 'settings:setLocale',

  // renderer -> main (saved login / autofill)
  saveLogin: 'login:save',
  clearLogin: 'login:clear',
  autofillLogin: 'login:autofill',

  // renderer -> main (plugins)
  setPluginEnabled: 'plugins:setEnabled',
  setPluginPermission: 'plugins:setPermission',
  reloadPlugins: 'plugins:reload',
  openPluginsFolder: 'plugins:openFolder',
  openPluginWindow: 'plugins:openWindow', // open a plugin's declared standalone window
  openPluginPanel: 'plugins:openPanel', // mount a plugin's config panel (config subpage)
  setPluginPanelBounds: 'plugins:panelBounds', // position the config panel over the renderer's placeholder
  closePluginPanel: 'plugins:closePanel', // unmount the config panel
  getPluginReadme: 'plugins:readme', // read a plugin's README.md (help subpage)

  // main -> renderer (events)
  stateChanged: 'app:stateChanged',
  playChime: 'app:playChime',
  playSound: 'app:playSound',
  promptAutofill: 'app:promptAutofill', // ask the renderer to open the autofill PIN modal
  openAccountSettings: 'app:openAccountSettings', // native menu -> renderer: open Settings on an account
  showSourcePicker: 'app:showSourcePicker', // main -> renderer: choose a screen/window to share

  // account-observer preload <-> main
  obMetrics: 'observer:metrics',
  obTheme: 'observer:theme',
  obNotification: 'observer:notification',
  obConnection: 'observer:connection',
  obFill: 'observer:fill', // main -> view: fill the login form (observe-only exception)
  obPushToTalk: 'observer:pushToTalk', // main -> view: gate wrapped microphone streams
  obSoundConfig: 'observer:soundConfig', // main -> view: mute Discord's own notification ding when a custom chime is set
  obCall: 'observer:call', // view -> main: this account is/ isn't in an active voice/video call
  obPluginMsg: 'observer:pluginMsg', // discord-view content script <-> main (plugin content relay)

  // main <-> sandboxed plugin host / windows / panels
  phMsg: 'pluginhost:msg', // main -> host/window (load/unload/event/accounts/broadcast)
  phCall: 'pluginhost:call', // host/window -> main (fire-and-forget plugin api calls, ready, errors)
  phInvoke: 'pluginhost:invoke', // host/window -> main (request/response: http, files, clipboard, hotkeys)
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
