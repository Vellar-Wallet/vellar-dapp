# @vela/extension

Companion execution surface (technical-doc.md §4.2, §12): popup UI, background service worker, content/injection bridge, dApp connection approvals, transaction signing popup, account selector, permission management, deep-link handoff to web app.

Design principle: high-frequency wallet actions live here; advanced workflows route back to the web app. No silent signing; origin always displayed (technical-doc.md §8.2).
