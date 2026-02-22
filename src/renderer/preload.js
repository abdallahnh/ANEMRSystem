const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  auth: {
    me: () => ipcRenderer.invoke('auth:me'),
    login: (username, pin) => ipcRenderer.invoke('auth:login', username, pin),
    logout: () => ipcRenderer.invoke('auth:logout')
  },
  users: {
    list: () => ipcRenderer.invoke('users:list'),
    create: (payload) => ipcRenderer.invoke('users:create', payload)
  },
  patients: {
    list: (q) => ipcRenderer.invoke('patients:list', q),
    get: (id) => ipcRenderer.invoke('patients:get', id),
    create: (payload) => ipcRenderer.invoke('patients:create', payload),
    update: (id, payload) => ipcRenderer.invoke('patients:update', id, payload),
    delete: (id) => ipcRenderer.invoke('patients:delete', id),
    summary: (patientId) => ipcRenderer.invoke('patients:summary', patientId)
  },
  visits: {
    listByPatient: (patientId) => ipcRenderer.invoke('visits:listByPatient', patientId),
    create: (payload) => ipcRenderer.invoke('visits:create', payload),
    delete: (id) => ipcRenderer.invoke('visits:delete', id)
  },
  bookings: {
    listByDate: (isoDate) => ipcRenderer.invoke('bookings:listByDate', isoDate),
    create: (payload) => ipcRenderer.invoke('bookings:create', payload),
    updateStatus: (bookingId, status) => ipcRenderer.invoke('bookings:updateStatus', bookingId, status)
  },
  reports: {
    summary: (fromIso, toIso) => ipcRenderer.invoke('reports:summary', fromIso, toIso)
  },
  db: {
    export: () => ipcRenderer.invoke('db:export'),
    import: () => ipcRenderer.invoke('db:import')
  },
  files: {
  listByPatient: (patientId) => ipcRenderer.invoke('files:listByPatient', patientId),
  pickAndUpload: (patientId) => ipcRenderer.invoke('files:pickAndUpload', patientId),
   toFileUrl: (relPath) => ipcRenderer.invoke('files:toFileUrl', relPath),
  open: (relPath) => ipcRenderer.invoke('files:open', relPath),
  delete: (fileId) => ipcRenderer.invoke('files:delete', fileId),
},
pdf: {
  reportHtml: (from,to) => ipcRenderer.invoke('pdf:report', { from, to }),
  patientHtml: (patientId) => ipcRenderer.invoke('pdf:patient', { patientId }),
  saveHtmlToPdf: (html, defaultName) => ipcRenderer.invoke('pdf:saveHtmlToPdf', { html, defaultName })
}
});