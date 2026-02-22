const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const Database = require('better-sqlite3');

let db;
let currentUser = null;

function dataDir() {
  const dir = app.getPath('userData');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function dbPath() {
  return path.join(dataDir(), 'anemr.sqlite');
}

function initDb() {
  db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  migrate();
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY,
      fullName TEXT NOT NULL,
      phone TEXT,
      dob TEXT,
      gender TEXT,
      nationalId TEXT,
      primaryDiagnosis TEXT,
      allergies TEXT,
      chronicConditions TEXT,
      longTermMeds TEXT,
      medicalSummary TEXT,
      notes TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lookupKey TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_patients_lookup ON patients(lookupKey);

    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      patientId TEXT NOT NULL,
      visitDate TEXT NOT NULL,
      reason TEXT,
      diagnosis TEXT,
      treatment TEXT,
      notes TEXT,
      amountPaid REAL NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      bookingId TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patientId);
    CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(visitDate);

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      bookingDate TEXT NOT NULL,
      time TEXT NOT NULL,
      patientId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'BOOKED',
      notes TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(bookingDate, time)
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(bookingDate);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      fullName TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'SECRETARY',
      pinHash TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      userId TEXT,
      action TEXT NOT NULL,
      entity TEXT,
      entityId TEXT,
      meta TEXT
    );
    CREATE TABLE IF NOT EXISTS patient_files (
    id TEXT PRIMARY KEY,
    patientId TEXT NOT NULL,
    fileName TEXT NOT NULL,
    mime TEXT,
    relPath TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_patient_files_pid ON patient_files(patientId);
  `);
}

function uuid8() { return Math.random().toString(16).slice(2, 10).toUpperCase(); }
function nowIso() { return new Date().toISOString(); }
function normalizeLookup(fullName, phone) {
  const n = (fullName || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
  const p = (phone || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
  return (n + ' ' + p).trim();
}
function hashPin(pin) {
  const salt = 'ANEMR_STATIC_SALT_V1';
  return crypto.createHash('sha256').update(salt + String(pin)).digest('hex');
}
function requireLogin() {
  if (!currentUser) throw new Error('Not logged in');
}
function requireDoctor() {
  requireLogin();
  if (currentUser.role !== 'DOCTOR') throw new Error('Doctor only');
}
function audit(action, entity=null, entityId=null, meta=null) {
  try {
    db.prepare(`INSERT INTO audit (id, at, userId, action, entity, entityId, meta)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('A-' + uuid8(), nowIso(), currentUser?.id || null, action, entity, entityId, meta ? JSON.stringify(meta) : null);
  } catch (_) {}
}

const auth = {
  me() { return currentUser ? { id: currentUser.id, username: currentUser.username, fullName: currentUser.fullName, role: currentUser.role } : null; },
  login(username, pin) {
    const u = db.prepare(`SELECT * FROM users WHERE username = ?`).get(String(username).trim());
    if (!u) throw new Error('Invalid username or PIN');
    if (u.pinHash !== hashPin(pin)) throw new Error('Invalid username or PIN');
    currentUser = { id: u.id, username: u.username, fullName: u.fullName, role: u.role };
    audit('LOGIN', 'USER', u.id);
    return auth.me();
  },
  logout() {
    if (currentUser) audit('LOGOUT', 'USER', currentUser.id);
    currentUser = null;
    return { ok: true };
  }
};

const users = {
  ensureFirstDoctor(username='admin', pin='1234', fullName='Doctor Admin') {
    const count = db.prepare(`SELECT COUNT(*) as c FROM users`).get().c;
    if (count > 0) return { ok: true, already: true };
    db.prepare(`INSERT INTO users (id, username, fullName, role, pinHash, createdAt)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run('U-' + uuid8(), username, fullName, 'DOCTOR', hashPin(pin), nowIso());
    return { ok: true, created: true };
  },
  list() {
    requireDoctor();
    return db.prepare(`SELECT id, username, fullName, role, createdAt FROM users ORDER BY createdAt DESC`).all();
  },
  create(payload) {
    requireDoctor();
    const username = String(payload.username || '').trim();
    const pin = String(payload.pin || '').trim();
    const fullName = String(payload.fullName || '').trim();
    const role = (payload.role === 'DOCTOR') ? 'DOCTOR' : 'SECRETARY';
    if (!username || !pin || !fullName) throw new Error('username, pin, fullName required');
    db.prepare(`INSERT INTO users (id, username, fullName, role, pinHash, createdAt)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run('U-' + uuid8(), username, fullName, role, hashPin(pin), nowIso());
    audit('CREATE_USER', 'USER', username, { role });
    return { ok: true };
  }
};

const patients = {
  list(q) {
    requireLogin();
    const query = (q || '').toString().trim().toLowerCase();
    if (!query) return db.prepare(`SELECT * FROM patients ORDER BY updatedAt DESC LIMIT 200`).all();
    return db.prepare(`SELECT * FROM patients WHERE lookupKey LIKE ? ORDER BY updatedAt DESC LIMIT 200`)
      .all(`%${query}%`);
  },
  get(id) {
    requireLogin();
    return db.prepare(`SELECT * FROM patients WHERE id = ?`).get(id);
  },
  create(p) {
    requireLogin();
    if (!p?.fullName?.trim()) throw new Error('Full name is required');
    const id = 'P-' + uuid8();
    const ts = nowIso();
    const lookupKey = normalizeLookup(p.fullName, p.phone);

    const isSecretary = currentUser.role === 'SECRETARY';

    db.prepare(`
      INSERT INTO patients (
        id, fullName, phone, dob, gender, nationalId, primaryDiagnosis,
        allergies, chronicConditions, longTermMeds, medicalSummary, notes,
        createdAt, updatedAt, lookupKey
      ) VALUES (
        @id, @fullName, @phone, @dob, @gender, @nationalId, @primaryDiagnosis,
        @allergies, @chronicConditions, @longTermMeds, @medicalSummary, @notes,
        @createdAt, @updatedAt, @lookupKey
      )
    `).run({
      id,
      fullName: p.fullName.trim(),
      phone: (p.phone || '').trim(),
      dob: p.dob || '',
      gender: (p.gender || '').trim(),
      nationalId: (p.nationalId || '').trim(),
      primaryDiagnosis: isSecretary ? '' : (p.primaryDiagnosis || '').trim(),
      allergies: isSecretary ? '' : (p.allergies || '').trim(),
      chronicConditions: isSecretary ? '' : (p.chronicConditions || '').trim(),
      longTermMeds: isSecretary ? '' : (p.longTermMeds || '').trim(),
      medicalSummary: isSecretary ? '' : (p.medicalSummary || '').trim(),
      notes: (p.notes || '').trim(),
      createdAt: ts,
      updatedAt: ts,
      lookupKey
    });

    audit('CREATE_PATIENT', 'PATIENT', id, { fullName: p.fullName });
    return { id };
  },
  update(id, p) {
    requireLogin();
    const existing = db.prepare(`SELECT * FROM patients WHERE id = ?`).get(id);
    if (!existing) throw new Error('Patient not found');

    const isSecretary = currentUser.role === 'SECRETARY';

    const fullName = (p.fullName ?? existing.fullName).toString().trim();
    const phone = (p.phone ?? existing.phone).toString().trim();
    const dob = (p.dob ?? existing.dob) || '';
    const gender = (p.gender ?? existing.gender) || '';
    const nationalId = (p.nationalId ?? existing.nationalId) || '';

    const primaryDiagnosis = isSecretary ? (existing.primaryDiagnosis || '') : ((p.primaryDiagnosis ?? existing.primaryDiagnosis) || '');
    const allergies = isSecretary ? (existing.allergies || '') : ((p.allergies ?? existing.allergies) || '');
    const chronicConditions = isSecretary ? (existing.chronicConditions || '') : ((p.chronicConditions ?? existing.chronicConditions) || '');
    const longTermMeds = isSecretary ? (existing.longTermMeds || '') : ((p.longTermMeds ?? existing.longTermMeds) || '');
    const medicalSummary = isSecretary ? (existing.medicalSummary || '') : ((p.medicalSummary ?? existing.medicalSummary) || '');

    const notes = (p.notes ?? existing.notes) || '';
    const lookupKey = normalizeLookup(fullName, phone);

    db.prepare(`
      UPDATE patients SET
        fullName=@fullName, phone=@phone, dob=@dob, gender=@gender, nationalId=@nationalId,
        primaryDiagnosis=@primaryDiagnosis, allergies=@allergies, chronicConditions=@chronicConditions,
        longTermMeds=@longTermMeds, medicalSummary=@medicalSummary, notes=@notes,
        updatedAt=@updatedAt, lookupKey=@lookupKey
      WHERE id=@id
    `).run({
      id, fullName, phone, dob, gender, nationalId,
      primaryDiagnosis, allergies, chronicConditions, longTermMeds, medicalSummary, notes,
      updatedAt: nowIso(),
      lookupKey
    });

    audit('UPDATE_PATIENT', 'PATIENT', id);
    return { ok: true };
  },
  summary(patientId) {
    requireLogin();
    const p = db.prepare(`SELECT * FROM patients WHERE id = ?`).get(patientId);
    if (!p) throw new Error('Patient not found');

    const recentVisits = db.prepare(`
      SELECT id, visitDate, reason, diagnosis, treatment, notes, amountPaid, createdAt, bookingId
      FROM visits
      WHERE patientId = ?
      ORDER BY visitDate DESC
      LIMIT 10
    `).all(patientId);

    const totals = db.prepare(`
      SELECT COUNT(*) as visitsCount, COALESCE(SUM(amountPaid),0) as lifetimeRevenue
      FROM visits WHERE patientId = ?
    `).get(patientId);

    const last = recentVisits[0] || null;
    return { patient: p, lastVisit: last, recentVisits, totals };
  },
  delete(id){
  requireLogin();
  // Only DOCTOR can delete patient (recommended)
  if (currentUser.role !== 'DOCTOR') throw new Error('Doctor only');

  const p = db.prepare(`SELECT * FROM patients WHERE id=?`).get(id);
  if (!p) throw new Error('Patient not found');

  const tx = db.transaction(() => {
    // delete visits
    db.prepare(`DELETE FROM visits WHERE patientId=?`).run(id);

    // delete bookings
    db.prepare(`DELETE FROM bookings WHERE patientId=?`).run(id);

    // delete file records
    const files = db.prepare(`SELECT * FROM patient_files WHERE patientId=?`).all(id);
    db.prepare(`DELETE FROM patient_files WHERE patientId=?`).run(id);

    // delete patient
    db.prepare(`DELETE FROM patients WHERE id=?`).run(id);

    // delete files from disk (best-effort)
    const dir = path.join(uploadsDir(), id);
    try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive:true, force:true }); } catch(_) {}
  });

  tx();
  audit('DELETE_PATIENT', 'PATIENT', id, { fullName: p.fullName });
  return { ok:true };
}
};

const visits = {
  listByPatient(patientId) {
    requireLogin();
    return db.prepare(`SELECT * FROM visits WHERE patientId = ? ORDER BY visitDate DESC`).all(patientId);
  },
  create(v) {
    requireLogin();
    if (!v?.patientId) throw new Error('patientId required');
    if (!v?.visitDate) throw new Error('visitDate required');

    const id = 'V-' + uuid8();
    const ts = nowIso();

    // ✅ invalid / empty / text => 0
    const rawPaid = (v.amountPaid ?? '').toString().trim();
    const cleaned = rawPaid.replace(/,/g, '').replace(/[^\d.-]/g, '');
    const amount = Number(cleaned);
    const amountPaid = (!rawPaid || isNaN(amount)) ? 0 : Math.max(0, amount);

    db.prepare(`
      INSERT INTO visits (
        id, patientId, visitDate, reason, diagnosis, treatment, notes, amountPaid, createdAt, bookingId
      ) VALUES (
        @id, @patientId, @visitDate, @reason, @diagnosis, @treatment, @notes, @amountPaid, @createdAt, @bookingId
      )
    `).run({
      id,
      patientId: v.patientId,
      visitDate: v.visitDate,
      reason: (v.reason || '').trim(),
      diagnosis: (v.diagnosis || '').trim(),
      treatment: (v.treatment || '').trim(),
      notes: (v.notes || '').trim(),
      amountPaid,
      createdAt: ts,
      bookingId: v.bookingId || null
    });

    audit('CREATE_VISIT', 'VISIT', id, { patientId: v.patientId, bookingId: v.bookingId || null });
    return { id };
  },
  delete(id){
  requireLogin();
  const row = db.prepare(`SELECT * FROM visits WHERE id=?`).get(id);
  if (!row) throw new Error('Visit not found');
  db.prepare(`DELETE FROM visits WHERE id=?`).run(id);
  audit('DELETE_VISIT', 'VISIT', id, { patientId: row.patientId });
  return { ok:true };
}
};

const bookings = {
  listByDate(isoDate) {
    requireLogin();
    return db.prepare(`
      SELECT b.*, p.fullName, p.phone
      FROM bookings b
      JOIN patients p ON p.id = b.patientId
      WHERE b.bookingDate = ?
      ORDER BY b.time ASC
    `).all(isoDate);
  },
  create(b) {
    requireLogin();
    if (!b?.bookingDate) throw new Error('bookingDate required');
    if (!b?.time) throw new Error('time required');
    if (!b?.patientId) throw new Error('patientId required');

    const id = 'B-' + uuid8();
    const ts = nowIso();

    try {
      db.prepare(`
        INSERT INTO bookings (
          id, bookingDate, time, patientId, status, notes, createdAt, updatedAt
        ) VALUES (
          @id, @bookingDate, @time, @patientId, 'BOOKED', @notes, @createdAt, @updatedAt
        )
      `).run({
        id,
        bookingDate: b.bookingDate,
        time: b.time,
        patientId: b.patientId,
        notes: (b.notes || '').trim(),
        createdAt: ts,
        updatedAt: ts
      });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) throw new Error('Slot already booked');
      throw e;
    }

    audit('CREATE_BOOKING', 'BOOKING', id, { date: b.bookingDate, time: b.time, patientId: b.patientId });
    return { id };
  },
  updateStatus(id, status) {
    requireLogin();
    const allowed = new Set(['BOOKED', 'ARRIVED', 'COMPLETED', 'CANCELLED', 'NOSHOW']);
    if (!allowed.has(status)) throw new Error('Invalid status');
    db.prepare(`UPDATE bookings SET status=?, updatedAt=? WHERE id=?`).run(status, nowIso(), id);
    audit('UPDATE_BOOKING_STATUS', 'BOOKING', id, { status });
    return { ok: true };
  }
};

const reports = {
  summary(fromIso, toIso) {
    requireLogin();
    const from = fromIso + 'T00:00:00.000Z';
    const to = toIso + 'T23:59:59.999Z';

    const row = db.prepare(`
      SELECT COUNT(DISTINCT patientId) AS uniquePatients,
             COUNT(*) AS visitsCount,
             COALESCE(SUM(amountPaid), 0) AS revenue
      FROM visits
      WHERE visitDate BETWEEN ? AND ?
    `).get(from, to);

    const byDay = db.prepare(`
      SELECT substr(visitDate, 1, 10) AS day,
             COUNT(*) AS visits,
             COALESCE(SUM(amountPaid), 0) AS revenue
      FROM visits
      WHERE visitDate BETWEEN ? AND ?
      GROUP BY day
      ORDER BY day DESC
    `).all(from, to);

    return { ...row, byDay };
  }
};
const files = {
  listByPatient(patientId){
    requireLogin();
    return db.prepare(`SELECT * FROM patient_files WHERE patientId=? ORDER BY createdAt DESC`).all(patientId);
  },
  addFromPath(patientId, sourcePath){
    requireLogin();
    if (!patientId) throw new Error('patientId required');
    if (!fs.existsSync(sourcePath)) throw new Error('File not found');

    const ext = path.extname(sourcePath).toLowerCase();
    const base = path.basename(sourcePath);
    const id = 'F-' + uuid8();
    const ts = nowIso();

    const destDir = patientUploadsDir(patientId);
    const safeName = `${Date.now()}_${base}`.replace(/[^\w.\-() ]+/g, '_');
    const destPath = path.join(destDir, safeName);

    fs.copyFileSync(sourcePath, destPath);

    const relPath = path.relative(dataDir(), destPath).replace(/\\/g,'/');
    const mime = (ext === '.png') ? 'image/png'
              : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
              : (ext === '.webp') ? 'image/webp'
              : 'application/octet-stream';

    db.prepare(`INSERT INTO patient_files (id, patientId, fileName, mime, relPath, createdAt)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, patientId, safeName, mime, relPath, ts);

    audit('UPLOAD_FILE', 'PATIENT', patientId, { fileId: id, fileName: safeName });
    return { id, fileName: safeName };
  },
  openAbsolutePath(relPath){
    // helper for renderer if needed later
    const abs = path.join(dataDir(), relPath);
    return abs;
  },
  delete(fileId){
  requireLogin();
  if(!fileId) throw new Error('fileId required');

  const row = db.prepare(`SELECT id, patientId, fileName, relPath FROM patient_files WHERE id=?`).get(fileId);
  if(!row) throw new Error('File not found');

  // delete from disk first (best-effort)
  const abs = path.join(dataDir(), row.relPath);
  try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch(_) {}

  // delete from DB (must affect 1 row)
  const info = db.prepare(`DELETE FROM patient_files WHERE id=?`).run(fileId);
  if(!info || info.changes !== 1){
    throw new Error('Delete failed (DB row not removed)');
  }

  audit('DELETE_FILE', 'PATIENT', row.patientId, { fileId, fileName: row.fileName });
  return { ok:true, deletedId: fileId };
}
};

function exportDb(destPath){
  requireLogin();

  // Force WAL → DB merge
  db.pragma('wal_checkpoint(FULL)');

  // Create a consistent snapshot db at destPath
  // NOTE: VACUUM INTO requires a literal string, so escape single quotes
  const safe = String(destPath).replace(/'/g, "''");
  db.exec(`VACUUM INTO '${safe}'`);

  return { ok:true, filePath: destPath };
}
function importDb(srcPath) {
  if (db) db.close();
  fs.copyFileSync(srcPath, dbPath());
  db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  migrate();
}

function uploadsDir() {
  const dir = path.join(dataDir(), 'uploads');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function patientUploadsDir(patientId) {
  const dir = path.join(uploadsDir(), patientId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function htmlEscape(s){
  return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function buildReportHtml({from, to, summary}) {
  const rows = (summary.byDay || []).map(r => `
    <tr>
      <td>${htmlEscape(r.day)}</td>
      <td>${htmlEscape(r.visits)}</td>
      <td>${Number(r.revenue||0).toFixed(2)}</td>
    </tr>
  `).join('');

  return `
  <html><head><meta charset="utf-8"/>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;padding:24px;}
    h1{margin:0 0 8px;}
    .muted{color:#555;font-size:12px;}
    table{width:100%;border-collapse:collapse;margin-top:12px;}
    th,td{border:1px solid #ccc;padding:8px;font-size:12px;}
    th{background:#f2f2f2;text-align:left;}
    .kpi{display:flex;gap:16px;margin-top:10px;}
    .box{border:1px solid #ccc;border-radius:8px;padding:10px;min-width:160px;}
    .v{font-size:18px;font-weight:700;margin-top:4px;}
  </style></head><body>
    <h1>Revenue Report</h1>
    <div class="muted">${htmlEscape(from)} → ${htmlEscape(to)}</div>
    <div class="kpi">
      <div class="box"><div class="muted">Unique Patients</div><div class="v">${summary.uniquePatients||0}</div></div>
      <div class="box"><div class="muted">Visits</div><div class="v">${summary.visitsCount||0}</div></div>
      <div class="box"><div class="muted">Revenue</div><div class="v">${Number(summary.revenue||0).toFixed(2)}</div></div>
    </div>
    <h3 style="margin-top:18px;">By Day</h3>
    <table>
      <thead><tr><th>Day</th><th>Visits</th><th>Revenue</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </body></html>`;
}

function buildPatientFileHtml({patient, totals, recentVisits, files}) {
  const vRows = (recentVisits||[]).map(v => `
    <tr>
      <td>${htmlEscape(v.visitDate)}</td>
      <td>${htmlEscape(v.reason||'')}</td>
      <td>${htmlEscape(v.diagnosis||'')}</td>
      <td>${htmlEscape(v.treatment||'')}</td>
      <td>${htmlEscape(v.notes||'')}</td>
      <td>${Number(v.amountPaid||0).toFixed(2)}</td>
    </tr>
  `).join('');

  const fRows = (files||[]).map(f => `
    <tr>
      <td>${htmlEscape(f.createdAt)}</td>
      <td>${htmlEscape(f.fileName)}</td>
    </tr>
  `).join('');

  return `
  <html><head><meta charset="utf-8"/>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;padding:24px;}
    h1{margin:0;}
    .muted{color:#555;font-size:12px;}
    table{width:100%;border-collapse:collapse;margin-top:12px;}
    th,td{border:1px solid #ccc;padding:8px;font-size:11px;vertical-align:top;}
    th{background:#f2f2f2;text-align:left;}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;}
    .card{border:1px solid #ccc;border-radius:8px;padding:10px;}
    .label{font-size:11px;color:#555;}
    .val{font-weight:700;margin-top:2px;}
  </style></head><body>
    <h1>Patient Medical File</h1>
    <div class="muted">${htmlEscape(patient.fullName)} — ${htmlEscape(patient.id)}</div>

    <div class="grid">
      <div class="card"><div class="label">Phone</div><div class="val">${htmlEscape(patient.phone||'')}</div></div>
      <div class="card"><div class="label">DOB / Gender</div><div class="val">${htmlEscape(patient.dob||'')} / ${htmlEscape(patient.gender||'')}</div></div>
      <div class="card"><div class="label">Diagnosis</div><div class="val">${htmlEscape(patient.primaryDiagnosis||'')}</div></div>
      <div class="card"><div class="label">Visits / Lifetime Revenue</div><div class="val">${totals.visitsCount||0} / ${Number(totals.lifetimeRevenue||0).toFixed(2)}</div></div>
      <div class="card"><div class="label">Allergies</div><div class="val">${htmlEscape(patient.allergies||'')}</div></div>
      <div class="card"><div class="label">Chronic</div><div class="val">${htmlEscape(patient.chronicConditions||'')}</div></div>
      <div class="card"><div class="label">Long-term Meds</div><div class="val">${htmlEscape(patient.longTermMeds||'')}</div></div>
      <div class="card"><div class="label">Medical Summary</div><div class="val">${htmlEscape(patient.medicalSummary||'')}</div></div>
    </div>

    <h3 style="margin-top:18px;">Visits</h3>
    <table>
      <thead><tr><th>Date</th><th>Reason</th><th>Diagnosis</th><th>Treatment</th><th>Notes</th><th>Paid</th></tr></thead>
      <tbody>${vRows}</tbody>
    </table>

    <h3 style="margin-top:18px;">Uploaded Files</h3>
    <table>
      <thead><tr><th>Uploaded At</th><th>File</th></tr></thead>
      <tbody>${fRows}</tbody>
    </table>
  </body></html>`;
}
function deletePatientFile(fileId){
  const row = db.prepare(`SELECT * FROM patient_files WHERE id=?`).get(fileId);
  if(!row) throw new Error('File not found');

  // delete file from disk
  const abs = path.join(dataDir(), row.relPath);
  try { fs.unlinkSync(abs); } catch(_) {}

  // delete record
  db.prepare(`DELETE FROM patient_files WHERE id=?`).run(fileId);
  return { ok:true };
}

module.exports = { initDb, patients, visits, bookings, reports, exportDb, importDb, auth, users, files, buildReportHtml, buildPatientFileHtml };