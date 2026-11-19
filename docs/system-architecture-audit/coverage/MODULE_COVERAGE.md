# Module coverage
| Module | Reading depth | Evidence |
|---|---|---|
| Auth (`js/auth/*`) | metrics | graph, grep |
| App shell / router (`js/app.js`, `router.js`) | metrics | graph |
| Tasks + `workflow` function | backend I, UI metrics | function read; RLS grants read |
| Campaigns / Content plans / PPTX | metrics | migrations 009/012/013 by grep |
| Client Hub + Drive panel | backend I, UI metrics | |
| CRM, HR, Employees, Departments, Projects, Calendar, Documents, Reports, Admin, Dashboard, QR | metrics only | graph only |
| Finance UI + `finance` function + 017 | backend P, UI metrics | |
| Chat / Calls / Realtime | backend P, services metrics | |
| Broadcast | grep only | |
| PWA / push | P | `sw.js` grep, `build.mjs` head |
| Kite Drive (function + PHP) | I | |
