import { cpSync, existsSync, mkdirSync } from 'node:fs';
if (!existsSync('dist')) mkdirSync('dist');
for (const f of ['index.html','app.js','app.css','local-api.js']) cpSync(f, `dist/${f}`);
