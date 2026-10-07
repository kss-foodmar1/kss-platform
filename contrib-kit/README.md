# KSS widget contributor kit

1. Read `widget-contributor-brief.md` (what to build and the rules).
2. Build your hand-over folder like `example/`.
3. Before sending, run (Node 18+, no install):

       node validate-widgets.js <your-folder>

   Fix every ✗. Explain any ! you leave in your README.
4. Send the folder (zip) to KSS.

`fmh-file.js` is KSS's own reader for FMH exports; the validator uses it to
read your `samples/`. Do not change it.
