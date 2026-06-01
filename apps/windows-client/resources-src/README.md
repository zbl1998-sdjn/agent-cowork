# Windows Resource Scripts

This folder is the hand-written TypeScript source for the legacy classic-script
resource bundle loaded by `../resources/index.html`.

- Edit `*.ts` here.
- Run `npm run build:resources` to regenerate `../resources/*.js`.
- `npm run check:resource-js` verifies the generated JS is current and still
  parses as classic browser scripts.

The emitted JS paths are kept stable because the host static asset whitelist,
Tauri resource preview, and smoke tests load those files directly.
