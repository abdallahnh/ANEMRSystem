// src/renderer/renderer.js

const $ = (id) => document.getElementById(id);

let selectedPatientId = '';
window.__activeBookingId = null;

// prevents async race when switching patients quickly
let __filesReqToken = 0;

function toast(msg, isError = false) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  t.style.borderColor = isError ? '#ef4444' : '#223044';
  setTimeout(() => t.classList.add('hidden'), 2600);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function formatIso(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.navbtn').forEach(b => b.classList.remove('active'));

  const sec = document.getElementById(`view-${view}`);
  if (sec) sec.classList.remove('hidden');

  const nav = document.querySelector(`.navbtn[data-view="${view}"]`);
  if (nav) nav.classList.add('active');   // ✅ don't assume it exists
}

document.querySelectorAll('.navbtn').forEach(btn =>
  btn.addEventListener('click', () => switchView(btn.dataset.view))
);

function setSelectedPatient(p) {
  selectedPatientId = p?.id || '';
  const label = selectedPatientId
    ? `Selected: ${p.fullName} (${selectedPatientId})`
    : 'No patient selected';

  const pill1 = $('selectedPatientPill');
  const pill2 = $('selectedPatientPill2');
  if (pill1) pill1.textContent = label;
  if (pill2) pill2.textContent = label;

  // Clear files immediately so old patient images don't stay visible
  const grid = $('patientFilesGrid');
  if (grid) {
    grid.innerHTML = selectedPatientId
      ? '<div class="muted">Loading files…</div>'
      : '<div class="muted">Select a patient first.</div>';
  }
}

// ---------------------------
// Auth / WhoAmI
// ---------------------------
async function refreshWhoAmI() {
  const me = await window.api.auth.me();
  const who = $('whoami');
  const btnLogout = $('btnLogout');
  const navUsers = $('navUsers');
  const navReports = $('navReports');

  if (!me) {
    if (who) who.textContent = 'Not logged in';
    if (btnLogout) btnLogout.classList.add('hidden');
    if (navUsers) navUsers.classList.add('hidden');
    if (navReports) navReports.classList.add('hidden');
    switchView('login');
    return;
  }

  if (who) who.textContent = `${me.fullName} — ${me.role} (${me.username})`;
  if (btnLogout) btnLogout.classList.remove('hidden');

  // Reports visible for both roles
  if (navReports) navReports.classList.remove('hidden');

  // Users only for Doctor
  if (navUsers) {
    if (me.role === 'DOCTOR') navUsers.classList.remove('hidden');
    else navUsers.classList.add('hidden');
  }

  switchView('patients');
}
// Make "No patient selected" pill open picker
function openPatientPicker(){
  const modal = $('patientPickerModal');
  if(!modal) return toast('Picker UI not found', true);

  modal.classList.remove('hidden');

  // load data after modal is visible
  setTimeout(()=> {
    $('patientPickerQuery')?.focus();
    loadPatientPickerList(($('patientPickerQuery')?.value || '').trim());
  }, 0);
}

function closePatientPicker(){
  $('patientPickerModal')?.classList.add('hidden');
}

// pill opens picker
$('selectedPatientPill2')?.addEventListener('click', openPatientPicker);
$('selectedPatientPill')?.addEventListener('click', openPatientPicker);

$('patientPickerClose')?.addEventListener('click', closePatientPicker);
$('patientPickerModal')?.addEventListener('click', (e)=>{
  if(e.target?.id === 'patientPickerModal') closePatientPicker();
});

$('patientPickerSearch')?.addEventListener('click', async ()=>{
  const q = ($('patientPickerQuery')?.value || '').trim();
  await loadPatientPickerList(q);
});

$('patientPickerQuery')?.addEventListener('keydown', async (e)=>{
  if(e.key === 'Enter'){
    const q = ($('patientPickerQuery')?.value || '').trim();
    await loadPatientPickerList(q);
  }
});

// Backup/restore
$('btnExport')?.addEventListener('click', async () => {
  try {
    const res = await window.api.db.export();
    if (res?.ok) toast('Backup exported ✅ ' + res.filePath);
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

$('btnImport')?.addEventListener('click', async () => {
  try {
    const res = await window.api.db.import();
    if (res?.ok) {
      toast('Backup restored ✅');
      await refreshPatients();
    }
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

// Login / Logout
$('btnLogin')?.addEventListener('click', async () => {
  try {
    const u = $('login_username')?.value.trim();
    const p = $('login_pin')?.value.trim();
    if (!u || !p) return toast('Enter username + PIN', true);

    await window.api.auth.login(u, p);
    if ($('login_pin')) $('login_pin').value = '';
    toast('Logged in ✅');

    await refreshWhoAmI();
    await refreshPatients();
    await refreshBookings();
    await refreshUsers();
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

$('btnLogout')?.addEventListener('click', async () => {
  try {
    await window.api.auth.logout();
    toast('Logged out');
    await refreshWhoAmI();
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

$('btnLoginOpen')?.addEventListener('click', () => switchView('login'));

// ---------------------------
// Patients
// ---------------------------
async function refreshPatients(query = '') {
  const list = await window.api.patients.list(query);
  const table = $('patientsTable');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';

  list.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${escapeHtml(p.id)}</td>
       <td>${escapeHtml(p.fullName || '')}</td>
       <td>${escapeHtml(p.phone || '')}</td>
       <td>${escapeHtml(formatIso(p.updatedAt))}</td>`;

    tr.addEventListener('click', async () => {
      try {
        const full = await window.api.patients.get(p.id);
        fillPatientForm(full);
        setSelectedPatient(full);

        // load fast
        await refreshPatientFiles();
        await refreshVisitsForSelected();
        await renderPatientSummary();
      } catch (e) {
        toast(String(e.message || e), true);
      }
    });

    tbody.appendChild(tr);
  });
}

function fillPatientForm(p) {
  if ($('p_id')) $('p_id').value = p?.id || '';
  if ($('p_fullName')) $('p_fullName').value = p?.fullName || '';
  if ($('p_phone')) $('p_phone').value = p?.phone || '';
  if ($('p_dob')) $('p_dob').value = (p?.dob || '').slice(0, 10);
  if ($('p_gender')) $('p_gender').value = p?.gender || '';
  if ($('p_nid')) $('p_nid').value = p?.nationalId || '';
  if ($('p_diag')) $('p_diag').value = p?.primaryDiagnosis || '';
  if ($('p_allergies')) $('p_allergies').value = p?.allergies || '';
  if ($('p_chronic')) $('p_chronic').value = p?.chronicConditions || '';
  if ($('p_meds')) $('p_meds').value = p?.longTermMeds || '';
  if ($('p_summary')) $('p_summary').value = p?.medicalSummary || '';
  if ($('p_notes')) $('p_notes').value = p?.notes || '';
}

function patientPayload() {
  return {
    fullName: $('p_fullName')?.value.trim() || '',
    phone: $('p_phone')?.value.trim() || '',
    dob: $('p_dob')?.value || '',
    gender: $('p_gender')?.value.trim() || '',
    nationalId: $('p_nid')?.value.trim() || '',
    primaryDiagnosis: $('p_diag')?.value.trim() || '',
    allergies: $('p_allergies')?.value.trim() || '',
    chronicConditions: $('p_chronic')?.value.trim() || '',
    longTermMeds: $('p_meds')?.value.trim() || '',
    medicalSummary: $('p_summary')?.value.trim() || '',
    notes: $('p_notes')?.value.trim() || ''
  };
}

$('btnPatientSearch')?.addEventListener('click', async () => refreshPatients($('patientSearch')?.value || ''));
$('patientSearch')?.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') await refreshPatients($('patientSearch')?.value || '');
});

$('btnPatientNew')?.addEventListener('click', () => {
  fillPatientForm({});
  setSelectedPatient({});
  const box = $('patientSummary');
  if (box) box.innerHTML = 'Select a patient to view summary.';
  toast('New patient form ready');
});

$('btnPatientSave')?.addEventListener('click', async () => {
  try {
    const payload = patientPayload();
    if (!payload.fullName) return toast('Full name is required', true);

    const res = await window.api.patients.create(payload);
    toast('Saved ✅ ' + res.id);

    await refreshPatients($('patientSearch')?.value || '');

    const full = await window.api.patients.get(res.id);
    fillPatientForm(full);
    setSelectedPatient(full);

    await refreshPatientFiles();
    await refreshVisitsForSelected();
    await renderPatientSummary();
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

$('btnPatientUpdate')?.addEventListener('click', async () => {
  try {
    const id = $('p_id')?.value.trim();
    if (!id) return toast('Select a patient first', true);

    await window.api.patients.update(id, patientPayload());
    toast('Updated ✅ ' + id);

    await refreshPatients($('patientSearch')?.value || '');

    const full = await window.api.patients.get(id);
    fillPatientForm(full);
    setSelectedPatient(full);

    await refreshPatientFiles();
    await renderPatientSummary();
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

// Optional: delete patient (Doctor-only enforced in backend)
$('btnPatientDelete')?.addEventListener('click', async () => {
  try {
    const id = $('p_id')?.value.trim();
    if (!id) return toast('Select a patient first', true);

    const ok = confirm(`Delete patient ${id}?\nThis will also delete visits, bookings, and uploaded files.\nThis cannot be undone.`);
    if (!ok) return;

    await window.api.patients.delete(id);
    toast('Patient deleted ✅');

    fillPatientForm({});
    setSelectedPatient({});
    const box = $('patientSummary');
    if (box) box.innerHTML = 'Select a patient to view summary.';

    await refreshPatients($('patientSearch')?.value || '');
    await refreshBookings();
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

// ---------------------------
// Patient Summary (right panel)
// ---------------------------
async function renderPatientSummary() {
  const box = $('patientSummary');
  if (!box) return;

  if (!selectedPatientId) {
    box.textContent = 'Select a patient to view summary.';
    return;
  }

  try {
    const res = await window.api.patients.summary(selectedPatientId);
    const p = res.patient;
    const t = res.totals || { visitsCount: 0, lifetimeRevenue: 0 };
    const last = res.lastVisit;

    const top = `
      <div style="margin-bottom:8px;">
        <div><b>${escapeHtml(p.fullName || '')}</b> — ${escapeHtml(p.phone || '')}</div>
        <div class="muted">DOB: ${escapeHtml((p.dob || '').slice(0,10))} | Gender: ${escapeHtml(p.gender || '')}</div>
        <div class="muted">Visits: ${t.visitsCount} | Lifetime Revenue: ${Number(t.lifetimeRevenue || 0).toFixed(2)}</div>
      </div>
    `;

    const profile = `
      <div class="muted" style="margin-bottom:8px;">
        <div><b>Diagnosis:</b> ${escapeHtml(p.primaryDiagnosis || '')}</div>
        <div><b>Allergies:</b> ${escapeHtml(p.allergies || '')}</div>
        <div><b>Chronic:</b> ${escapeHtml(p.chronicConditions || '')}</div>
        <div><b>Meds:</b> ${escapeHtml(p.longTermMeds || '')}</div>
        <div><b>Summary:</b> ${escapeHtml(p.medicalSummary || '')}</div>
      </div>
    `;

    const lastHtml = last ? `
      <div style="margin-top:6px;">
        <div><b>Last Visit:</b> ${escapeHtml(formatIso(last.visitDate))}</div>
        <div class="muted">${escapeHtml(last.reason||'')} | ${escapeHtml(last.diagnosis||'')} | Paid: ${Number(last.amountPaid||0).toFixed(2)}</div>
      </div>
    ` : `<div class="muted">No visits yet.</div>`;

    const list = (res.recentVisits || []).map(v => `
      <tr>
        <td>${escapeHtml(formatIso(v.visitDate))}</td>
        <td>${escapeHtml(v.reason || '')}</td>
        <td>${escapeHtml(v.diagnosis || '')}</td>
        <td>${Number(v.amountPaid || 0).toFixed(2)}</td>
      </tr>
    `).join('');

    const recent = `
      <div style="margin-top:10px;">
        <div class="muted"><b>Recent visits (last 10)</b></div>
        <table class="table" style="margin-top:6px;">
          <thead><tr><th>Date</th><th>Reason</th><th>Diagnosis</th><th>Paid</th></tr></thead>
          <tbody>${list || ''}</tbody>
        </table>
      </div>
    `;

    box.innerHTML = top + profile + lastHtml + recent;

    await refreshPatientFiles();
  } catch (e) {
    box.textContent = String(e.message || e);
  }
}

// ---------------------------
// Visits
// ---------------------------
async function refreshVisitsForSelected() {
  const table = $('visitsTable');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';
  if (!selectedPatientId) return;

  const list = await window.api.visits.listByPatient(selectedPatientId);

  list.forEach(v => {
    const tr = document.createElement('tr');
    tr.classList.add('visitRow');

    tr.innerHTML = `
      <td>${escapeHtml(formatIso(v.visitDate))}</td>
      <td>${escapeHtml(v.reason || '')}</td>
      <td>${escapeHtml(v.diagnosis || '')}</td>
      <td>${Number(v.amountPaid || 0).toFixed(2)}</td>
      <td><button type="button" class="secondary small" data-del="${escapeHtml(v.id)}">Delete</button></td>
    `;

    const btn = tr.querySelector('button[data-del]');
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const id = btn.dataset.del;
      const ok = confirm(`Delete this visit?\nVisit ID: ${id}\nThis cannot be undone.`);
      if (!ok) return;

      await window.api.visits.delete(id);
      toast('Visit deleted ✅');
      await refreshVisitsForSelected();
      await renderPatientSummary();
    });

    tbody.appendChild(tr);
  });
}

$('btnVisitSave')?.addEventListener('click', async () => {
  try {
    if (!selectedPatientId) return toast('Select a patient first', true);

    const visitDate = $('v_date')?.value;
    if (!visitDate) return toast('Visit date is required', true);

    const payload = {
      patientId: selectedPatientId,
      visitDate: new Date(visitDate).toISOString(),
      bookingId: window.__activeBookingId || null,
      reason: $('v_reason')?.value.trim() || '',
      diagnosis: $('v_diagnosis')?.value.trim() || '',
      treatment: $('v_treatment')?.value.trim() || '',
      notes: $('v_notes')?.value.trim() || '',
      amountPaid: (($('v_paid')?.value ?? '') + '').trim()
    };

    const hasAny = payload.reason || payload.diagnosis || payload.treatment || payload.notes || payload.amountPaid;
    if (!hasAny) return toast('Visit is empty. Fill at least one field.', true);

    payload.amountPaid = payload.amountPaid.replace(/,/g, '');

    await window.api.visits.create(payload);

    window.__activeBookingId = null;
    if ($('visitBookingHint')) $('visitBookingHint').textContent = '';

    toast('Visit saved ✅');

    if ($('v_reason')) $('v_reason').value = '';
    if ($('v_diagnosis')) $('v_diagnosis').value = '';
    if ($('v_treatment')) $('v_treatment').value = '';
    if ($('v_notes')) $('v_notes').value = '';
    if ($('v_paid')) $('v_paid').value = '';

    await refreshVisitsForSelected();
    await renderPatientSummary();
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

// ---------------------------
// Booking
// ---------------------------
if ($('b_date')) $('b_date').value = todayIsoDate();

async function refreshBookings() {
  const date = $('b_date')?.value;
  const table = $('bookingTable');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';
  if (!date) return;

  const list = await window.api.bookings.listByDate(date);

  list.forEach(b => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(b.time)}</td>
      <td>${escapeHtml(b.fullName || '')}${b.phone ? ' — ' + escapeHtml(b.phone) : ''}</td>
      <td>${escapeHtml(b.status)}</td>
      <td>
        <button data-act="ARRIVED" data-id="${escapeHtml(b.id)}">Arrived</button>
        <button data-act="COMPLETED" data-id="${escapeHtml(b.id)}">Completed</button>
        <button
          data-act="COMPLETE_OPEN"
          data-id="${escapeHtml(b.id)}"
          data-pid="${escapeHtml(b.patientId)}"
          data-date="${escapeHtml(b.bookingDate)}"
          data-time="${escapeHtml(b.time)}"
        >Complete + Visit</button>
        <button data-act="CANCELLED" data-id="${escapeHtml(b.id)}">Cancel</button>
      </td>
    `;

    tr.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const act = btn.dataset.act;
          const id = btn.dataset.id;

          if (act === 'COMPLETE_OPEN') {
            await window.api.bookings.updateStatus(id, 'COMPLETED');

            const pid = btn.dataset.pid;
            const patient = await window.api.patients.get(pid);
            fillPatientForm(patient);
            setSelectedPatient(patient);

            switchView('visits');

            const dtLocal = `${btn.dataset.date}T${btn.dataset.time}`;
            if ($('v_date')) $('v_date').value = dtLocal;

            window.__activeBookingId = id;
            if ($('visitBookingHint')) $('visitBookingHint').textContent =
              `Linked Booking: ${id} (will attach to the visit when you save)`;

            toast('Booking completed ✅ Fill visit then Save Visit');

            await refreshPatientFiles();
            await refreshVisitsForSelected();
            await renderPatientSummary();
            await refreshBookings();
            return;
          }

          await window.api.bookings.updateStatus(id, act);
          toast('Updated ✅');
          await refreshBookings();
        } catch (e) {
          toast(String(e.message || e), true);
        }
      });
    });

    tbody.appendChild(tr);
  });
}

$('btnBookingLoad')?.addEventListener('click', refreshBookings);

$('btnBookingSave')?.addEventListener('click', async () => {
  try {
    if (!selectedPatientId) return toast('Select a patient first', true);

    const date = $('b_date')?.value;
    const time = $('b_time')?.value.trim();
    if (!date) return toast('Pick a date', true);
    if (!time) return toast('Time is required (e.g. 09:00)', true);

    await window.api.bookings.create({
      bookingDate: date,
      time,
      patientId: selectedPatientId,
      notes: $('b_notes')?.value.trim() || ''
    });

    toast('Booking saved ✅');
    if ($('b_notes')) $('b_notes').value = '';
    await refreshBookings();
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

// Booking slots dropdown
function pad2(n) { return String(n).padStart(2, '0'); }

function buildDefaultSlots(start = '09:00', end = '20:00', stepMin = 15) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const startM = sh * 60 + sm;
  const endM = eh * 60 + em;

  const slots = [];
  for (let m = startM; m <= endM; m += stepMin) {
    slots.push(`${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`);
  }
  return slots;
}

function initBookingSlots() {
  const sel = $('b_time_select');
  const input = $('b_time');
  if (!sel || !input) return;

  sel.innerHTML = '';
  const slots = buildDefaultSlots('09:00', '20:00', 15);

  slots.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    sel.appendChild(opt);
  });

  sel.value = slots[0];
  input.value = sel.value;

  sel.addEventListener('change', () => { input.value = sel.value; });
}

// ---------------------------
// Reports
// ---------------------------
function setReportRange(from, to) {
  if ($('r_from')) $('r_from').value = from;
  if ($('r_to')) $('r_to').value = to;
}

function monthRange(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const from = `${y}-${pad2(m)}-01`;
  const endDate = new Date(Date.UTC(y, m, 0));
  const to = `${endDate.getUTCFullYear()}-${pad2(endDate.getUTCMonth() + 1)}-${pad2(endDate.getUTCDate())}`;
  return { from, to };
}

$('btnThisMonth')?.addEventListener('click', () => {
  const d = new Date();
  const ym = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  if ($('r_month')) $('r_month').value = ym;
  const r = monthRange(ym);
  setReportRange(r.from, r.to);
});

$('btnLastMonth')?.addEventListener('click', () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  const ym = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  if ($('r_month')) $('r_month').value = ym;
  const r = monthRange(ym);
  setReportRange(r.from, r.to);
});

$('r_month')?.addEventListener('change', () => {
  const ym = $('r_month')?.value;
  if (!ym) return;
  const r = monthRange(ym);
  setReportRange(r.from, r.to);
});

$('btnReportRun')?.addEventListener('click', async () => {
  try {
    const from = $('r_from')?.value;
    const to = $('r_to')?.value;
    if (!from || !to) return toast('Pick from/to dates', true);

    const res = await window.api.reports.summary(from, to);
    if ($('k_unique')) $('k_unique').textContent = String(res.uniquePatients || 0);
    if ($('k_visits')) $('k_visits').textContent = String(res.visitsCount || 0);
    if ($('k_rev')) $('k_rev').textContent = Number(res.revenue || 0).toFixed(2);

    const table = $('reportTable');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    tbody.innerHTML = '';

    (res.byDay || []).forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(r.day)}</td><td>${r.visits}</td><td>${Number(r.revenue || 0).toFixed(2)}</td>`;
      tbody.appendChild(tr);
    });

    toast('Report generated ✅');
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

// ---------------------------
// Users (Doctor only)
// ---------------------------
async function refreshUsers() {
  const table = $('usersTable');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';

  try {
    const list = await window.api.users.list();
    list.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${escapeHtml(u.username)}</td>
         <td>${escapeHtml(u.fullName)}</td>
         <td>${escapeHtml(u.role)}</td>
         <td>${escapeHtml(formatIso(u.createdAt))}</td>`;
      tbody.appendChild(tr);
    });
  } catch {
    // doctor-only endpoint
  }
}

$('btnCreateUser')?.addEventListener('click', async () => {
  try {
    const payload = {
      fullName: $('u_fullName')?.value.trim() || '',
      username: $('u_username')?.value.trim() || '',
      pin: $('u_pin')?.value.trim() || '',
      role: $('u_role')?.value || 'SECRETARY'
    };
    if (!payload.fullName || !payload.username || !payload.pin) return toast('Fill fullName/username/pin', true);

    await window.api.users.create(payload);
    toast('User created ✅');

    if ($('u_fullName')) $('u_fullName').value = '';
    if ($('u_username')) $('u_username').value = '';
    if ($('u_pin')) $('u_pin').value = '';

    await refreshUsers();
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

// ---------------------------
// PDF Exports
// ---------------------------
$('btnReportPdf')?.addEventListener('click', async () => {
  try {
    const from = $('r_from')?.value;
    const to = $('r_to')?.value;
    if (!from || !to) return toast('Pick from/to dates first', true);

    const res = await window.api.pdf.reportHtml(from, to);
    if (!res?.ok) return toast('Failed to build report PDF', true);

    const save = await window.api.pdf.saveHtmlToPdf(res.html, `Report_${from}_to_${to}.pdf`);
    if (save?.ok) toast('PDF saved ✅ ' + save.filePath);
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

$('btnPatientPdf')?.addEventListener('click', async () => {
  try {
    if (!selectedPatientId) return toast('Select a patient first', true);

    const res = await window.api.pdf.patientHtml(selectedPatientId);
    if (!res?.ok) return toast('Failed to build patient PDF', true);

    const name = (($('p_fullName')?.value || 'Patient') + '').replace(/[^\w\- ]+/g, '_');
    const save = await window.api.pdf.saveHtmlToPdf(res.html, `PatientFile_${name}_${selectedPatientId}.pdf`);
    if (save?.ok) toast('PDF saved ✅ ' + save.filePath);
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

// ---------------------------
// Files + Modal Preview
// ---------------------------
function openImageModal(title, src) {
  const modal = $('imgModal');
  if (!modal) return;
  const t = $('imgModalTitle');
  const img = $('imgModalImg');
  if (t) t.textContent = title || 'Image';
  if (img) img.src = src;
  modal.classList.remove('hidden');
}

function closeImageModal() {
  const modal = $('imgModal');
  if (!modal) return;
  const img = $('imgModalImg');
  if (img) img.src = '';
  modal.classList.add('hidden');
}

// bind modal close once
(function bindImageModal() {
  $('imgModalClose')?.addEventListener('click', closeImageModal);
  $('imgModal')?.addEventListener('click', (e) => {
    if (e.target?.id === 'imgModal') closeImageModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeImageModal();
  });
})();

$('btnUploadImages')?.addEventListener('click', async () => {
  try {
    if (!selectedPatientId) return toast('Select a patient first', true);
    const res = await window.api.files.pickAndUpload(selectedPatientId);
    if (res?.ok) {
      toast(`Uploaded ${res.uploaded.length} file(s) ✅`);
      await refreshPatientFiles();
    }
  } catch (e) {
    toast(String(e.message || e), true);
  }
});

async function refreshPatientFiles() {
  const grid = $('patientFilesGrid');
  if (!grid) return;
 grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(140px, 1fr))';
  grid.style.gap = '12px';
  const myToken = ++__filesReqToken;

  grid.innerHTML = '';
  const pid = selectedPatientId;

  if (!pid) {
    grid.innerHTML = '<div class="muted">Select a patient first.</div>';
    return;
  }

  grid.innerHTML = '<div class="muted">Loading files…</div>';

  const list = await window.api.files.listByPatient(pid);

  // if selection changed while awaiting, ignore results
  if (myToken !== __filesReqToken) return;
  if (pid !== selectedPatientId) return;

  if (!list.length) {
    grid.innerHTML = '<div class="muted">No files uploaded.</div>';
    return;
  }

  grid.innerHTML = '';
  for (const f of list) {
    const url = await window.api.files.toFileUrl(f.relPath);

    // selection may change during await
    if (myToken !== __filesReqToken) return;
    if (pid !== selectedPatientId) return;

   const box = document.createElement('div');
box.className = 'fileThumb';

box.innerHTML = `
  <button class="fileDel" type="button" title="Delete" data-del="${escapeHtml(f.id)}">✕</button>
  <img src="${url}" alt="file"/>
  <div class="cap">${escapeHtml(f.fileName || '')}</div>
`;

// click image => modal
box.addEventListener('click', ()=>{
  openImageModal(f.fileName || 'Image', url);
});

// click delete => stop + confirm
const delBtn = box.querySelector('.fileDel');
delBtn.addEventListener('click', async (e)=>{
  e.preventDefault();
  e.stopPropagation();

  const ok = confirm(`Delete this file?\n${f.fileName}\nThis cannot be undone.`);
  if(!ok) return;

  await window.api.files.delete(f.id);
  toast('File deleted ✅');
  await refreshPatientFiles();
});
grid.appendChild(box);
  }
}
async function loadPatientPickerList(query=''){
  const tbody = $('patientPickerTbody');
  if(!tbody) return;

  tbody.innerHTML = `<tr><td colspan="3" class="muted">Loading…</td></tr>`;

  let list = [];
  try{
    list = await window.api.patients.list(query || '');
  }catch(e){
    tbody.innerHTML = `<tr><td colspan="3" class="muted">Error loading patients: ${escapeHtml(e.message||String(e))}</td></tr>`;
    return;
  }

  if(!list || !list.length){
    tbody.innerHTML = `<tr><td colspan="3" class="muted">No results</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  list.forEach(p=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(p.id)}</td>
      <td>${escapeHtml(p.fullName || '')}</td>
      <td>${escapeHtml(p.phone || '')}</td>
    `;

    tr.addEventListener('click', async ()=>{
      try{
        const full = await window.api.patients.get(p.id);
        fillPatientForm(full);
        setSelectedPatient(full);

        await refreshVisitsForSelected();
        await renderPatientSummary();
        await refreshPatientFiles();

        closePatientPicker();
        toast('Patient selected ✅');
      }catch(e){
        toast(String(e.message||e), true);
      }
    });

    tbody.appendChild(tr);
  });
}
// ---------------------------
// Init
// ---------------------------
(async function init() {
  try {
    // ✅ show login immediately (even before auth check)
    if (document.getElementById('view-login')) switchView('login');

    $('navUsers')?.classList.add('hidden');
    $('navReports')?.classList.add('hidden');

    // ✅ only init booking slots if the booking inputs exist
    if ($('b_time_select') && $('b_time')) initBookingSlots();

    const m = $('r_month');
    if (m && typeof pad2 === 'function') {
      m.value = `${new Date().getFullYear()}-${pad2(new Date().getMonth() + 1)}`;
      $('btnThisMonth')?.click();
    }

    await refreshWhoAmI();

    const me = await window.api.auth.me();
    if (me) {
      await refreshPatients();
      await refreshBookings();
      await refreshUsers();
      toast('Ready ✅');
    }
  } catch (e) {
    console.error('INIT ERROR', e);
    toast('INIT ERROR: ' + String(e.message || e), true);
    if (document.getElementById('view-login')) switchView('login');
  }
})();