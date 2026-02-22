# ANEMRSystem (Electron MVP)

Desktop EMR MVP (HTML + Electron + SQLite)

## Features
- Login (Username + PIN)
- Doctor/Secretary roles
- Doctor can create users
- Patient Summary (profile + recent visits + lifetime revenue)
- Monthly report quick actions (This Month / Last Month)
- Booking: Complete + Visit flow (links booking -> visit)
- Amount Paid parsing hardened (invalid text -> 0)

## Run
```bash
npm install
npm start
```

## Build installers
### Windows (EXE installer via NSIS)
```bash
npm run build:win
```

### macOS (DMG)
```bash
npm run build:mac
```

Output: dist/

## Default first-run user
- Username: admin
- PIN: 1234

## Online saving (no backend)
Use Backup (Export) and upload the SQLite file to Google Drive.
Use Restore (Import) to load it back.
