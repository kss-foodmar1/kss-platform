# Brief for contributors: building widgets for the KSS Dashboard

Give this whole file to your AI agent before it starts. It explains what the KSS Dashboard is, how a widget is made, and what to hand over, so that what you build can go straight into the product.

## 1. What the KSS Dashboard is

A multi-tenant web app (Node/Express, MySQL, plain JavaScript in the browser, Chart.js) for Thai F&B companies that use Food Market Hub (FMH).

Every screen is built from three layers:

| Layer | What it is | Who writes it |
|---|---|---|
| **Report source** | A table of rows, cached per company. Either pulled from the FMH Public Reports API (`purchase-analysis`, `sales-analysis`, `stock-count`, `production`, …), computed on the server from other sources (`pos-sales`, `ck-audit`), or filled from an uploaded file. | KSS core team |
| **Widget template** | A JSON description of one chart or table over one or more report sources: which rows, which fields, how to aggregate, how to draw. No code. | You |
| **Dashboard** | A page of widgets that a company admin picks from the catalog. | The customer |

The browser never talks to FMH. The server keeps one cache per company per report source, and every widget reads that cache.

## 2. What we want from you

Your Stock Movement Explorer is a complete separate app. We do **not** want to embed it. We want its *ideas* to become:

1. **File profiles** — how to read each FMH export you already understand: Stock Card, Stock Adjustment, Stock Count, Stock Transfer, Stock Wastage, Production History, COGS. Your adapters, header maps and `samples/` folder are the valuable part.
2. **Row contracts** — for each report, the rows your logic needs, using the **FMH API field names** (snake_case, as in the FMH report catalog), so a file upload and an API sync produce identical rows.
3. **Widget templates** — JSON, in the format in section 4, for each view worth keeping: KPI cards, the two event charts, the movement ledger table, product ranking, branch × movement-type heatmap, and so on.
4. **Computed source specs (only if needed)** — if a view needs logic a template can't express (your normalized `StockMovement` ledger merging six reports, say), describe it as a **pure function**: input rows from named report sources, output rows with named fields. Include worked input → output examples. KSS will implement it as a server-side "local source", the way `pos-sales` and `ck-audit` work today.

## 3. Rules (the platform's, not preferences)

- **No React, Next.js, Cloudflare, D1 or new npm packages in what you deliver.** Templates are JSON. A computed source is a spec plus a plain JS function with no imports.
- **No FMH connection, API keys or quota of your own.** KSS's server pulls FMH data, caches it and controls quota.
- **Rows only, never pre-drawn charts.** A widget gets rows and a config; the dashboard draws them.
- **Field names = FMH API field names.** Where a file header has no API equivalent, propose a snake_case name and say so.
- **Thai labels** for names, descriptions, column labels and footnotes. English is handled by a translation dictionary.
- **No customer personal data** (customer names, phone numbers from POS files) leaves the browser. Aggregate first.
- **Quantities in different units are never added together.** You already handle this; keep the rule explicit in the spec.
- **Every template states its empty case** (`empty_message`) and anything that could mislead (`foot`).

## 4. The widget template format

```json
{
  "template_key": "stock_waste_by_branch",
  "name": "มูลค่าของเสียตามสาขา",
  "description": "One sentence a restaurant owner understands: what it shows and why it matters.",
  "category": "Stock",
  "report_source": "wastage-lines",
  "chart_type": "bar",
  "config": {
    "size": "half",
    "row_filter": { "op": "gt", "a": { "field": "wastage_value" }, "b": 0 },
    "group_by": ["branch"],
    "value": { "op": "sum", "field": "wastage_value" },
    "sort": "desc",
    "top_n": 10,
    "format": "currency",
    "page_filter": "branch",
    "empty_message": "ไม่มีของเสียในช่วงนี้",
    "foot": "มูลค่าตามต้นทุนต่อหน่วยใน FMH"
  }
}
```

**Chart types:** `kpi`, `bar`, `line` (also stacked bars, with day/week/month buckets), `table`, `donut`, `pareto`, `scatter`, `treemap`, `range`, `stack`, `panels`, `tabs_bar`, `heatmap`, `sensitivity`, `menu_breakdown`.

**Common config keys:**
- `size`: `half` | `full`
- `rows`: 1 | 2 | 3 (height)
- `group_by`, `series_by`, `date_fields` + `bucket` (`day`/`week`/`month`), `bucket_toggle`
- `value` (a metric): `sum`, `count`, `count_distinct`, `avg`, `min`, `max`, `div`, `ratio_pct`, `sum_where`, `count_where`, `pct_change`, `diff`
- `metrics` (KPI cards)
- `columns` + `sort_by` + `top_n` (tables)
- `row_filter`: predicates `gt`, `in`, `and`, `or`, `not`, …
- `derived`: per-row arithmetic `add` / `sub` / `mul` / `div` / `pct_of`, text `party_short` / `clean_name` / `join` / `weekday`
- `sources` + `pivot`: several report sources lined up on a key (cross-report)
- Heatmaps: `row_field`, `col_field` or `col_date`, `scale` (`global` / `row` / `diverging_row` / `threshold_col`)
- `page_filter`: `branch` / `supplier` / `customer`
- `format`: `currency` / `number` / `pct`
- `empty_message`, `foot`

If a view needs something not on this list, describe it in plain words with an example. Don't invent keys.

## 5. Report sources already available

`purchase-analysis`, `sales-analysis`, `menu-costing` (recipes), `cogs`, `cogs-trend`, `stock-by-category`, `stock-flow`, `stock-count`, `production`, `batch`, `wastage-lines`, `wastage-trend`, `wastage-top-products`, `wastage-top-branches`, `product-variance`, `picking`, `credit-notes`, `price-comparison`, `pos-sales` (from POS files), `ck-audit` (branch purchase audit), and more.

The FMH API only returns about the last 90 days. Older months come from uploaded export files merged in front of the API data. So for every report you cover, the file profile matters as much as the template.

## 6. What to hand over (one folder)

```
widgets/
  README.md            what each widget answers, for whom, and known limits
  templates.json       array of widget templates (section 4)
  profiles.json        per FMH export: detect headers, header → API field map,
                       number fields, date fields, document-number field, date field
  rows/<source>.json   10–30 example rows per report source, API field names
  computed/<name>.md   only if needed: inputs, outputs, rules, worked examples
  computed/<name>.js   the pure function (rows in → rows out), no imports
  samples/             the real FMH export files used (anonymise customer data)
```

## 7. Acceptance checklist

- [ ] Every template uses only the chart types and config keys in section 4.
- [ ] Every field a template reads exists in `rows/<source>.json`.
- [ ] Every file profile was tested on a real export in `samples/`.
- [ ] Mixed units are never summed; any value that depends on unit cost says so in `foot`.
- [ ] The empty case and misleading cases are covered by `empty_message` / `foot`.
- [ ] No keys, no network calls, no frameworks, no customer personal data.

KSS reviews the folder, ports the profiles into the upload reader, adds any computed source, loads the templates into the catalog and tests them on Demo Co before they reach customers.
