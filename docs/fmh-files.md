# History from FMH export files (beyond the 90-day API window)

FMH's API only serves about the last 90 days, and the sync reads 80. For six months or a full year, the customer exports older months from FMH's report screen and uploads the files. The dashboard then shows:

- API data for recent days
- file data for the period before that

## Where

- **Company admin:** ✎ จัดการ Dashboard → ข้อมูลย้อนหลังจากไฟล์ FMH
- **KSS staff:** Admin Console → company → section 7
- **Dashboard pages that read a supported report:** the status bar shows an "อัปโหลดไฟล์ย้อนหลัง" button to admins.

## Supported reports

| Report | Source | Document key | Status |
|---|---|---|---|
| Sales Analysis | `sales-analysis` | `so_number` | Verified against a real export (Oct 2026) |
| Purchase Analysis | `purchase-analysis` | `po_number` | Header mapping inferred from the Sales layout. A file with other headers is refused with the missing column named. Verify with a real export. |

Accepted formats: .xlsx and CSV (comma, semicolon or tab). Old .xls is refused with instructions.

## How it works

1. The browser reads the file (`public/fmh-file.js`, no dependencies; xlsx is unzipped with `DecompressionStream`).
   - Headers are mapped to the API's field names, so widgets read file rows exactly like synced rows.
   - Dates (dd/mm/yyyy, Buddhist era, Excel serials) become ISO.
   - Footer total lines are skipped.
2. Rows go up in chunks of 2,000: `begin → rows… → commit`. Nothing is visible before commit.
3. Replacement is **per document**, not per date range. FMH exports filter on a date the file doesn't name, so a month file can hold an SO from the previous month's last day.
   - Uploading a document again replaces its lines.
   - An older upload left with no lines is removed.
4. `lib/fmhFiles.js` merges file rows into the report cache:
   - Only rows dated before the API window (`apiWindowStart()`) are used.
   - Any document the API also has is dropped from the file side — the API wins.
   - File rows carry `_file: 1`, so incremental syncs strip them and add them back.
   - A company with no API data at all uses every file row.
5. Coverage is stored in the cache meta as `history {api_from, file_from, file_to, file_rows}` and served as `meta.history`.

## Limits

- History is kept for 731 days.
- At most 250,000 rows per company per report.
- Grouped pulls (server-side totals) still cover only the API window. Widgets that read them say so when the range is longer than 85 days.

## Dashboard

- **6 เดือน / 1 ปี chips** appear on pages that read a supported report.
- **Bucket default:** ranges over 120 days open trend widgets with a day/week/month toggle by month. An explicit pick this session wins.
- **Empty periods** stay on the time axis as gaps, so a missing month is visible.
- **Coverage banner:** shows when the picked range starts before a report's data.
- **Gap warning:** shows when there is a gap between the last file and the API window.
- **Widget note:** a widget that puts two reports side by side notes it when they cover different spans.
- Responses are gzip-compressed (`compression`), since a year of lines is several MB of JSON.

## Tests

`node scripts/test-fmh-files.js [Report-SALES_ANALYSIS.xlsx]` runs 29 checks against a running server. The checks cover:

- reading the export
- access rules
- replacement by document
- the API-wins merge
- full and incremental syncs
- delete
