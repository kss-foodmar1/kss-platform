# POS sales upload (Foodstory) → COGS widgets

Foodstory POS has no API, but it exports sales as CSV. The **POS sales** feature joins that export with FMH recipe costs, so restaurants on Foodstory get COGS and gross margin on the dashboard.

## Flow

1. A company admin opens **✎ จัดการ Dashboard → ยอดขาย POS** and uploads the CSV. KSS staff can do the same in Admin Console → company → section 6.
   - Foodstory's export is "Sale by bill detail" (`salebybilldetail`). Other POS CSVs work if they have date, menu, quantity and net columns.
2. The browser reads the file (`public/pos-parse.js`) and sends only daily totals per branch and menu.
   - Bill numbers, customer names and phone numbers never reach the server.
   - The sale date comes from **วันที่ชำระเงิน**. Sales are **ราคาสุทธิ** (net of item discounts).
   - Option suffixes are removed from the menu name. For example, `Cappuccino - นมโอ๊ต x 1, - คั่วเข้ม x 1,` counts as `Cappuccino`.
   - The "รวม" footer row is skipped.
3. A new upload replaces the same days at the same branches, so re-exporting a period is safe.
4. **Matching** works on the menu name.
   - Names that differ only in spacing, case or punctuation are matched automatically.
   - Everything else is matched by hand once, and the choice is remembered (`pos_menu_map`).
   - Names that look similar get a one-click suggestion, which still has to be confirmed.
   - Lines that are not dishes (delivery fee, service charge) can be marked **ไม่ใช่อาหาร**. They are then left out of COGS %.
5. The report source `pos-sales` is computed in `lib/posSales.js` and cached like an FMH report.
   - It is rebuilt on upload, on mapping changes, after recipes sync, and when Refresh is pressed. Refresh has no cooldown for this source.
   - It uses no FMH quota, apart from the small `menu-costing|by_menu` recipe pull when that is not cached yet.

## Numbers

- COGS = quantity sold × the current FMH recipe cost per serving (Σ ingredient `total_cost`).
- FMH has one current recipe cost, not a history, so older days are costed at today's recipe cost.
- COGS % and GM are over **matched** sales only. **จับคู่สูตรได้** shows what share of food sales that covers.
- The cache holds the 120 days ending at the newest uploaded sale. Older days stay in the database.

## Widgets (category "POS COGS")

| Widget | What it shows |
|---|---|
| `pos_cogs_kpi` | KPI cards |
| `pos_cogs_trend` | Daily trend |
| `pos_menu_margin` | Per-menu table |
| `pos_low_margin` | Lowest-margin menus |
| `pos_menu_gp` | GP pareto |
| `pos_branch_cogs` | COGS % by branch |
| `pos_category_mix` | Sales by POS category |
| `pos_unmatched` | Menus not matched to a recipe yet |
| `pos_gm_recipe_vs_purchase` | Recipe GM vs actual-spend GM, against FMH purchases (Cross-report) |

## Demo

A company with `data_source = 'demo'` and no upload gets a generated POS file for the demo restaurant. It includes:

- one English POS name that needs mapping
- a delivery fee
- two items with no recipe

Uploading a real file replaces the demo file. Deleting that file brings the demo file back.

## Tests

`node scripts/test-pos.js [foodstory.csv]` runs 44 checks against a running server.
