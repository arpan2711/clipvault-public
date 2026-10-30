// Bridge between the sandboxed UI pages and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('clipvault', {
  getState: () => ipcRenderer.invoke('app:state'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  resetHotkeys: () => ipcRenderer.invoke('settings:resetHotkeys'),
  suspendHotkeys: (suspend) => ipcRenderer.invoke('hotkeys:suspend', suspend),

  toggleBuffer: () => ipcRenderer.invoke('buffer:toggle'),
  saveClip: () => ipcRenderer.invoke('clip:save'),
  toggleRecording: () => ipcRenderer.invoke('recording:toggle'),

  listLibrary: () => ipcRenderer.invoke('library:list'),
  rename: (file, name) => ipcRenderer.invoke('library:rename', file, name),
  remove: (file) => ipcRenderer.invoke('library:delete', file),
  trim: (file, start, end) => ipcRenderer.invoke('library:trim', file, start, end),
  copyFile: (file) => ipcRenderer.invoke('library:copy', file),
  getInputs: (file) => ipcRenderer.invoke('library:inputs', file),
  filmstrip: (file) => ipcRenderer.invoke('library:filmstrip', file), // file URL of the trim lane's stills, or null
  showInFolder: (file) => ipcRenderer.invoke('library:show', file),
  openExternally: (file) => ipcRenderer.invoke('library:open', file),
  startDrag: (file) => ipcRenderer.send('library:drag', file),
  setFavorite: (file, on) => ipcRenderer.invoke('library:favorite', file, on),
  removeMany: (files) => ipcRenderer.invoke('library:deleteMany', files),
  prepareFile: (file) => ipcRenderer.invoke('library:prepare', file), // a virtual clip becomes a file
  // Free up space (virtual clips): a read-only preview, then doing what it showed.
  previewFreeSpace: () => ipcRenderer.invoke('virtual:preview'),
  freeUpSpace: (token) => ipcRenderer.invoke('virtual:free', token),

  // League match records (matches.js): rows newest first, one full record by key.
  listMatches: () => ipcRenderer.invoke('matches:list'),
  getMatch: (key) => ipcRenderer.invoke('matches:get', key),
  championIcons: (names) => ipcRenderer.invoke('champions:icons', names),
  gameIcons: (keys) => ipcRenderer.invoke('icons:game', keys), // ["item:3031", ...] -> { key: { url, name } | null }
  showLog: () => ipcRenderer.invoke('app:showLog'),
  // Update check (update.js): the state is in getState().update; open = the release page on GitHub.
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  openUpdate: () => ipcRenderer.invoke('update:open'),
  // Bug reports (bugreport.js): report = { what, steps, diagnostics }.
  bugDiagnostics: () => ipcRenderer.invoke('bug:diagnostics'),
  submitBug: (report) => ipcRenderer.invoke('bug:submit', report),
  saveBugReport: (report) => ipcRenderer.invoke('bug:save', report),
  onBugReport: on('bug-report'),
  refreshMatches: () => ipcRenderer.invoke('matches:refresh'),

  makeHighlightVideo: (mapFile, opts) => ipcRenderer.invoke('edit:highlights', mapFile, opts),
  mergeVideos: (files) => ipcRenderer.invoke('edit:merge', files),
  shareVideo: (file, targetMB, audioTrack) => ipcRenderer.invoke('edit:share', file, targetMB, audioTrack),

  openFolder: () => ipcRenderer.invoke('folder:open'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),

  onStatus: on('status'),
  onLibraryChanged: on('library:changed'),
  onMatchesChanged: on('matches:changed'),
  onToast: on('toast'),
  onSound: on('sound'),
  onNavigate: on('navigate'),
  onOpenReel: on('open-reel'),

  // Kill cam window (killcam/killcam.html) and the Settings button that tries it.
  onKillCam: on('killcam'),
  onKillCamBig: on('killcam:big'),
  onKillCamEdit: on('killcam:edit'),
  onKillCamHide: on('killcam:hide'), // the window was hidden: stop playing
  killCamDrag: (d) => ipcRenderer.send('killcam:drag', d),
  killCamEditDone: () => ipcRenderer.send('killcam:edit-done'),
  moveKillCam: () => ipcRenderer.invoke('killcam:move'),
  resetKillCamSpot: () => ipcRenderer.invoke('killcam:reset-spot'),
  killCamDone: () => ipcRenderer.send('killcam:done'),
  tryKillCam: () => ipcRenderer.invoke('killcam:try'),
});
