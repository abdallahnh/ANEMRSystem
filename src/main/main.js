const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { initDb, patients, visits, bookings, reports, exportDb, importDb, auth, users, files, buildReportHtml, buildPatientFileHtml } = require('./services');
const { shell } = require('electron');
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, '../renderer/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  initDb();

  // Ensure a first doctor exists (only if users table empty)
  users.ensureFirstDoctor('admin', '1234', 'Doctor Admin');

  // Auth
  ipcMain.handle('auth:me', () => auth.me());
  ipcMain.handle('auth:login', (_e, username, pin) => auth.login(username, pin));
  ipcMain.handle('auth:logout', () => auth.logout());

  // Users (Doctor-only)
  ipcMain.handle('users:list', () => users.list());
  ipcMain.handle('users:create', (_e, payload) => users.create(payload));

  // Patients
  ipcMain.handle('patients:list', (_e, q) => patients.list(q));
  ipcMain.handle('patients:get', (_e, id) => patients.get(id));
  ipcMain.handle('patients:create', (_e, payload) => patients.create(payload));
  ipcMain.handle('patients:update', (_e, id, payload) => patients.update(id, payload));
  ipcMain.handle('patients:summary', (_e, patientId) => patients.summary(patientId));

  // Visits
  ipcMain.handle('visits:listByPatient', (_e, patientId) => visits.listByPatient(patientId));
  ipcMain.handle('visits:create', (_e, payload) => visits.create(payload));

  // Bookings
  ipcMain.handle('bookings:listByDate', (_e, isoDate) => bookings.listByDate(isoDate));
  ipcMain.handle('bookings:create', (_e, payload) => bookings.create(payload));
  ipcMain.handle('bookings:updateStatus', (_e, bookingId, status) => bookings.updateStatus(bookingId, status));

  // Reports
  ipcMain.handle('reports:summary', (_e, fromIso, toIso) => reports.summary(fromIso, toIso));

  // Backup / restore
  ipcMain.handle('db:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export Database Backup',
      defaultPath: 'anemr_backup.sqlite'
    });
    if (canceled || !filePath) return { ok: false };
    exportDb(filePath);
    return { ok: true, filePath };
  });

  ipcMain.handle('db:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import Database Backup',
      properties: ['openFile'],
      filters: [{ name: 'SQLite', extensions: ['sqlite', 'db'] }]
    });
    if (canceled || !filePaths?.[0]) return { ok: false };
    importDb(filePaths[0]);
    return { ok: true, filePath: filePaths[0] };
  });
  // Deletes
ipcMain.handle('visits:delete', (_e, id) => visits.delete(id));
ipcMain.handle('patients:delete', (_e, id) => patients.delete(id));

// Files (images)
ipcMain.handle('files:listByPatient', (_e, patientId) => files.listByPatient(patientId));
ipcMain.handle('files:pickAndUpload', async (_e, patientId) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Select patient images',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','webp'] }]
  });
  if (canceled || !filePaths?.length) return { ok:false };
  const out = filePaths.map(p => files.addFromPath(patientId, p));
  return { ok:true, uploaded: out };
});
ipcMain.handle('files:toFileUrl', (_e, relPath) => {
  const abs = path.join(app.getPath('userData'), relPath);
  return 'file://' + abs;
});

ipcMain.handle('files:open', async (_e, relPath) => {
  const abs = path.join(app.getPath('userData'), relPath);
  await shell.openPath(abs);
  return { ok:true };
});
ipcMain.handle('files:delete', (_e, fileId) => {
  return files.delete(fileId);
});
// PDF exports
ipcMain.handle('pdf:saveHtmlToPdf', async (_e, { html, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save PDF',
    defaultPath: defaultName || 'export.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return { ok:false };

  const bw = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true }
  });

  await bw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const pdfData = await bw.webContents.printToPDF({
    printBackground: true,
    marginsType: 0
  });
  bw.close();

  require('fs').writeFileSync(filePath, pdfData);
  return { ok:true, filePath };
});

// Build report/patient pdf html server-side (optional)
ipcMain.handle('pdf:report', async (_e, { from, to }) => {
  const summary = reports.summary(from, to);
  const html = buildReportHtml({ from, to, summary });
  return { ok:true, html };
});

ipcMain.handle('pdf:patient', async (_e, { patientId }) => {
  const s = patients.summary(patientId);
  const fileRows = files.listByPatient(patientId);
  const html = buildPatientFileHtml({
    patient: s.patient,
    totals: s.totals,
    recentVisits: s.recentVisits,
    files: fileRows
  });
  return { ok:true, html };
});

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});