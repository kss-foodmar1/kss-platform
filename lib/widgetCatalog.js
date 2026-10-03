// The built-in Widget Catalog.
//
// A widget template = one report source + a chart_type (which generic renderer
// draws it) + a default config. Templates are company-agnostic: the KSS team
// builds them once here, then places instances of them onto any company's
// dashboards from the Admin Console (with per-instance config overrides).
//
// syncCatalog() upserts these into widget_templates on every boot, keyed by
// template_key — except templates the team has edited in the Admin Console
// (customized = TRUE), which are left alone so their edits aren't overwritten.
//
// Config mini-language (evaluated in public/app.js):
//   metric: { op: 'sum', field }          field may be an array = fallback list
//           { op: 'count' }
//           { op: 'count_distinct', field }
//           { op: 'div', a, b }            a / b
//           { op: 'ratio_pct', a, b }      a / b * 100
//           { op: 'pct_change', from, to } (to - from) / from * 100
//           { op: 'diff', a, b }           a - b
//           { op: 'min'|'max'|'avg', field }  across the rows in the group,
//                                          skipping rows where it is missing
//
//   The row layer runs BEFORE any of the above, per row rather than across
//   rows, and is what the Line Checks widgets are built on:
//     derived:     [{ field, expr }]       adds a column to each row
//     row_filter:  a predicate              keeps only the rows it selects
//     empty_message:                        what to say when the filter keeps
//                                           nothing — for an exception list
//                                           that is good news, not an error
//   expr:   number | 'field_name' | { field } | { const }
//           { op: 'add'|'sub'|'mul'|'div'|'pct_of'|'abs', a, b }
//           { op: 'days', from, to }       whole days between two date fields,
//                                          null when either end is missing
//   predicate: { op: 'and'|'or', rules } | { op: 'not', rule }
//           { op: 'blank'|'present', field }
//           { op: 'gt'|'gte'|'lt'|'lte', a, b }
//           { op: 'differs', a, b, tolerance }   |a-b| > tolerance
//           { op: 'matches', field, pattern }
//
//   The pivot runs BEFORE the row layer and is what makes a widget read two
//   reports at once — the dashboard joining them itself, the way someone would
//   in a spreadsheet, because FMH has no report that spans both:
//     sources: [{ as, source, group_by }]   the pulls this widget needs
//     pivot: { key_field, key: { <alias>: <field|{field,bucket}> }, columns }
//     columns: [{ field, from: <alias>, metric }]  aggregate that side, or
//              [{ field, from, first: <field> }]   carry a label across
//   Every bucket also gets <alias>_rows, so a month built from two lines of
//   data is visible rather than passing as a real number. The join is an outer
//   join: a key present on one side only still produces a row, which is how
//   "bought but in no recipe" works at all.
//
//   scripts/test-row-layer.js checks all of this against hand-worked answers.
//
//   format: 'currency' | 'number' | 'decimal1' | 'pct' | 'pct_signed'
//   size:   'full' | 'half' | 'third'     width on the dashboard grid
//   color_mode (bar): 'signed' = diverging blue (+) / chili (-);
//                     'margin' = status red (<0) / amber (<20%) / green
// Series colors are validated for color-blind separation (dataviz validator,
// light + dark): PO gold #A9812F -> GRN blue #2F6FB0 -> Invoice chili #BE4229.
// Green is reserved for "good" status, so it's never used as a series color.
const pool = require('../db/pool');

const sum = (field) => ({ op: 'sum', field });
const MENU = ['menu_name', 'menu_code'];
const INGREDIENT = ['ingredient_name', 'ingredient_code'];

const CHART_TYPES = ['kpi', 'bar', 'line', 'table', 'sensitivity', 'menu_breakdown', 'donut', 'pareto', 'scatter', 'treemap', 'range', 'stack', 'panels'];

// Supplier Quality templates share one definition of "invoiced", "short" and
// "over", so the scorecard, the chart and the line list can never disagree.
function supplierQualityTemplates() {
  const TOL = 0.02; // ±2% before a line counts as different from the PO
  const invoiced = { op: 'present', field: 'invoice_number' };
  const short = { op: 'and', rules: [invoiced, { op: 'lt', a: 'invoice_quantity', b: { op: 'mul', a: 'po_qty', b: 1 - TOL } }] };
  const over = { op: 'and', rules: [invoiced, { op: 'gt', a: 'invoice_quantity', b: { op: 'mul', a: 'po_qty', b: 1 + TOL } }] };
  const shortValue = { op: 'mul', a: { op: 'sub', a: 'po_qty', b: 'invoice_quantity' }, b: 'po_price' };
  const bySupplier = {
    sources: [{ as: 'p', source: 'purchase-analysis' }],
    pivot: {
      key_field: 'supplier',
      key: { p: 'supplier' },
      columns: [
        { field: 'closed_lines', from: 'p', metric: { op: 'count_where', where: invoiced } },
        { field: 'short_lines', from: 'p', metric: { op: 'count_where', where: short } },
        { field: 'over_lines', from: 'p', metric: { op: 'count_where', where: over } },
        { field: 'short_value', from: 'p', metric: { op: 'sum_where', where: short, expr: shortValue } },
        { field: 'po_count', from: 'p', metric: { op: 'count_distinct', field: 'po_number' } },
      ],
    },
    derived: [
      { field: 'short_pct', expr: { op: 'pct_of', a: 'short_lines', b: 'closed_lines' } },
      { field: 'risk', expr: { op: 'wilson_lb', a: 'short_lines', b: 'closed_lines' } },
    ],
    row_filter: { op: 'gt', a: 'closed_lines', b: 0 },
    empty_message: 'ยังไม่มีบรรทัดที่วางบิลแล้วในช่วงนี้',
  };
  return [
    {
      template_key: 'sq_scorecard',
      name: 'Scorecard ซัพพลายเออร์: ใครส่งของไม่ครบเป็นประจำ',
      description: 'ทุกซัพพลายเออร์ในตารางเดียว บรรทัดที่ปิดบิลแล้ว ส่งขาดกี่บรรทัด คิดเป็นกี่ % มูลค่าที่ขาด และคะแนนความเสี่ยงที่ปรับตามจำนวนข้อมูล',
      category: 'Supplier Quality',
      report_source: 'purchase-analysis',
      chart_type: 'table',
      config: {
        size: 'full',
        ...bySupplier,
        sort_by: { field: 'risk', dir: 'desc' },
        columns: [
          { field: 'supplier', label: 'ซัพพลายเออร์' },
          { field: 'closed_lines', label: 'บรรทัดที่ปิดบิล', format: 'number' },
          { field: 'short_lines', label: 'ส่งขาด (บรรทัด)', format: 'number' },
          { field: 'short_pct', label: '% บรรทัดที่ขาด', format: 'pct' },
          { field: 'risk', label: 'คะแนนความเสี่ยง', format: 'pct' },
          { field: 'short_value', label: 'มูลค่าที่ขาด', format: 'currency' },
          { field: 'over_lines', label: 'ส่งเกิน (บรรทัด)', format: 'number' },
          { field: 'po_count', label: 'จำนวน PO', format: 'number' },
        ],
        top_n: 100,
        foot: 'ส่งขาด = บรรทัดที่วางบิลแล้ว แต่จำนวนในบิลน้อยกว่า PO เกิน 2% · คะแนนความเสี่ยง = อัตราขาดขั้นต่ำที่มั่นใจได้ 95% ซัพพลายเออร์ที่มีข้อมูลน้อยจะได้คะแนนต่ำไว้ก่อน',
      },
    },
    {
      template_key: 'sq_short_value',
      name: 'มูลค่าที่ส่งขาด แยกตามซัพพลายเออร์',
      description: 'ของที่สั่งแต่ไม่ได้ คิดเป็นเงินตามราคา PO เจ้าที่อยู่บนสุดคือเจ้าที่ทำให้ครัวต้องหาของแทนหน้างานมากที่สุด',
      category: 'Supplier Quality',
      report_source: 'purchase-analysis',
      chart_type: 'bar',
      config: {
        size: 'half',
        ...bySupplier,
        row_filter: { op: 'gt', a: 'short_value', b: 0 },
        empty_message: 'ไม่มีบรรทัดที่ส่งขาดเกิน 2% ในช่วงนี้',
        group_by_field: ['supplier'],
        value: sum('short_value'),
        label_extra: { value: sum('short_lines'), suffix: ' บรรทัด' },
        top_n: 10,
        format: 'currency',
        color: '#BE4229',
        foot: 'มูลค่า = (จำนวน PO − จำนวนในบิล) × ราคา PO นับเฉพาะบรรทัดที่ปิดบิลแล้ว',
      },
    },
    {
      template_key: 'sq_mismatch_lines',
      name: 'บรรทัดที่จำนวนในบิลไม่ตรงกับ PO',
      description: 'รายการที่ส่งขาดหรือส่งเกินเกิน 2% เรียงจากที่ขาดเป็นเงินมากที่สุด ใช้คุยกับซัพพลายเออร์ได้ทันที',
      category: 'Supplier Quality',
      report_source: 'purchase-analysis',
      chart_type: 'table',
      config: {
        size: 'full',
        row_filter: { op: 'or', rules: [short, over] },
        derived: [
          { field: 'diff_qty', expr: { op: 'sub', a: 'invoice_quantity', b: 'po_qty' } },
          { field: 'diff_pct', expr: { op: 'pct_of', a: { op: 'sub', a: 'invoice_quantity', b: 'po_qty' }, b: 'po_qty' } },
          { field: 'diff_value', expr: { op: 'mul', a: { op: 'sub', a: 'invoice_quantity', b: 'po_qty' }, b: 'po_price' } },
        ],
        empty_message: 'บรรทัดที่ปิดบิลแล้วตรงกับ PO ทั้งหมด',
        sort_by: { field: 'diff_value', dir: 'asc' },
        columns: [
          { field: 'order_date', label: 'วันที่สั่ง' },
          { field: 'po_number', label: 'PO' },
          { field: 'supplier', label: 'ซัพพลายเออร์' },
          { field: 'product_name', label: 'สินค้า' },
          { field: 'uom', label: 'หน่วย' },
          { field: 'po_qty', label: 'สั่ง', format: 'number' },
          { field: 'grn_quantity', label: 'รับจริง', format: 'number' },
          { field: 'invoice_quantity', label: 'ในบิล', format: 'number' },
          { field: 'diff_pct', label: 'ต่างจาก PO', format: 'pct_signed' },
          { field: 'diff_value', label: 'มูลค่าส่วนต่าง', format: 'currency' },
          { field: 'invoice_number', label: 'เลขบิล' },
        ],
        top_n: 200,
      },
    },
    {
      // Cross-report: a line billed above what was received should come back
      // as a credit note. Purchase analysis knows the overbilling, the credit
      // note report knows the credit; they line up on invoice + product.
      template_key: 'sq_overbill_credit',
      name: 'บิลเกินของที่รับ ได้ใบลดหนี้คืนแล้วหรือยัง',
      description: 'บรรทัดที่ถูกเรียกเก็บมากกว่าที่รับจริง เทียบกับใบลดหนี้ของบิลและสินค้าเดียวกัน ยอดคงค้างคือเงินที่ยังไม่ได้คืน',
      category: 'Supplier Quality',
      report_source: 'purchase-analysis',
      chart_type: 'table',
      config: {
        size: 'full',
        sources: [
          { as: 'p', source: 'purchase-analysis' },
          { as: 'cn', source: 'credit-notes' },
        ],
        pivot: {
          key_field: 'line_key',
          key: { p: { fields: ['invoice_number', 'product_code'] }, cn: { fields: ['invoice_number', 'product_code'] } },
          columns: [
            { field: 'invoice_number', from: 'p', first: 'invoice_number' },
            { field: 'supplier', from: 'p', first: 'supplier' },
            { field: 'product_name', from: 'p', first: 'product_name' },
            { field: 'grn_qty', from: 'p', metric: sum('grn_quantity') },
            { field: 'invoice_qty', from: 'p', metric: sum('invoice_quantity') },
            {
              field: 'overbilled',
              from: 'p',
              metric: {
                op: 'sum_where',
                where: { op: 'gt', a: 'invoice_quantity', b: 'grn_quantity' },
                expr: { op: 'mul', a: { op: 'sub', a: 'invoice_quantity', b: 'grn_quantity' }, b: 'invoice_price' },
              },
            },
            { field: 'credited', from: 'cn', metric: sum('total') },
          ],
        },
        derived: [{ field: 'outstanding', expr: { op: 'sub', a: 'overbilled', b: 'credited' } }],
        row_filter: { op: 'gt', a: 'overbilled', b: 0 },
        empty_message: 'ไม่มีบรรทัดที่ถูกเรียกเก็บเกินของที่รับ',
        sort_by: { field: 'outstanding', dir: 'desc' },
        columns: [
          { field: 'invoice_number', label: 'เลขบิล' },
          { field: 'supplier', label: 'ซัพพลายเออร์' },
          { field: 'product_name', label: 'สินค้า' },
          { field: 'grn_qty', label: 'รับจริง', format: 'number' },
          { field: 'invoice_qty', label: 'ในบิล', format: 'number' },
          { field: 'overbilled', label: 'เก็บเกิน', format: 'currency' },
          { field: 'credited', label: 'ใบลดหนี้แล้ว', format: 'currency' },
          { field: 'outstanding', label: 'ยังไม่ได้คืน', format: 'currency' },
        ],
        top_n: 200,
        foot: 'จับคู่ด้วยเลขบิล + รหัสสินค้า ยอดติดลบแปลว่าได้ใบลดหนี้มากกว่าส่วนที่เก็บเกิน (อาจเป็นการลดหนี้เรื่องอื่น)',
      },
    },
  ];
}

function priceChangeTemplates() {
  const MIN_MOVE = 2; // % — smaller moves are rounding, not a price change
  const byProduct = {
    sources: [{ as: 'p', source: 'purchase-analysis' }],
    pivot: {
      key_field: 'product_key',
      key: { p: { fields: ['product_code', 'uom'] } },
      columns: [
        { field: 'product_name', from: 'p', first: 'product_name' },
        { field: 'uom', from: 'p', first: 'uom' },
        { field: 'category_name', from: 'p', first: 'category_name' },
        { field: 'supplier', from: 'p', latest: { value: 'supplier', by: 'order_date' } },
        { field: 'first_price', from: 'p', earliest: { value: 'price', by: 'order_date' } },
        { field: 'last_price', from: 'p', latest: { value: 'price', by: 'order_date' } },
        { field: 'first_date', from: 'p', earliest: { value: 'order_date', by: 'order_date' } },
        { field: 'last_date', from: 'p', latest: { value: 'order_date', by: 'order_date' } },
        { field: 'qty', from: 'p', metric: sum('qty') },
        // Unit price × quantity, not the line total, so tax and discounts do
        // not show up as a price change.
        { field: 'spend_at_price', from: 'p', metric: { op: 'sum_where', where: { op: 'present', field: 'price' }, expr: { op: 'mul', a: 'price', b: 'qty' } } },
        { field: 'buys', from: 'p', metric: { op: 'count' } },
      ],
    },
    derived: [
      { field: 'change_pct', expr: { op: 'pct_of', a: { op: 'sub', a: 'last_price', b: 'first_price' }, b: 'first_price' } },
      // What was actually paid above the window's first price. A rise late in
      // the window costs little yet; it grows with every order after it.
      { field: 'extra_paid', expr: { op: 'sub', a: 'spend_at_price', b: { op: 'mul', a: 'first_price', b: 'qty' } } },
    ],
    row_filter: {
      op: 'and',
      rules: [
        { op: 'gte', a: 'buys', b: 2 },
        { op: 'gte', a: { op: 'abs', a: 'change_pct' }, b: MIN_MOVE },
      ],
    },
    empty_message: 'ไม่มีสินค้าที่ราคาขยับเกิน 2% ในช่วงนี้ (นับเฉพาะสินค้าที่ซื้ออย่างน้อย 2 ครั้ง)',
  };
  return [
    {
      template_key: 'pc_movers',
      name: 'สินค้าที่ราคาขยับ',
      description: 'ราคาครั้งแรกเทียบราคาล่าสุดในช่วงที่เลือก และเงินที่จ่ายเพิ่มจริงจากการขยับนั้น เรียงจากที่กระทบกระเป๋ามากที่สุด',
      category: 'Price Change',
      report_source: 'purchase-analysis',
      chart_type: 'table',
      config: {
        size: 'full',
        ...byProduct,
        sort_by: { field: 'extra_paid', dir: 'desc' },
        columns: [
          { field: 'product_name', label: 'สินค้า' },
          { field: 'uom', label: 'หน่วย' },
          { field: 'supplier', label: 'ซัพพลายเออร์ล่าสุด' },
          { field: 'first_price', label: 'ราคาแรก', format: 'currency' },
          { field: 'last_price', label: 'ราคาล่าสุด', format: 'currency' },
          { field: 'change_pct', label: 'เปลี่ยน', format: 'pct_signed' },
          { field: 'qty', label: 'จำนวนที่ซื้อ', format: 'number' },
          { field: 'extra_paid', label: 'จ่ายเพิ่มจากราคาแรก', format: 'currency' },
          { field: 'last_date', label: 'ซื้อล่าสุด' },
        ],
        top_n: 200,
        foot: 'จ่ายเพิ่ม = (ราคาที่จ่ายจริง − ราคาครั้งแรกในช่วง) × จำนวน ติดลบแปลว่าประหยัดได้ · แยกตามรหัสสินค้า + หน่วย',
      },
    },
    {
      template_key: 'pc_extra_by_product',
      name: 'จ่ายเพิ่มจากราคาที่ขยับ ตามสินค้า',
      description: 'สินค้าที่ราคาขยับแล้วกระทบเงินมากที่สุด ทั้งขึ้นและลง',
      category: 'Price Change',
      report_source: 'purchase-analysis',
      chart_type: 'bar',
      config: {
        size: 'half',
        ...byProduct,
        group_by_field: ['product_name'],
        value: sum('extra_paid'),
        sort: 'abs_desc',
        color_mode: 'signed_cost',
        top_n: 10,
        format: 'currency',
        foot: 'แดง = จ่ายเพิ่ม · น้ำเงิน = ประหยัดได้ เทียบกับราคาครั้งแรกในช่วง',
      },
    },
    {
      template_key: 'pc_extra_by_category',
      name: 'จ่ายเพิ่มจากราคาที่ขยับ ตามหมวด',
      description: 'หมวดไหนกำลังแพงขึ้นในภาพรวม ใช้ตัดสินใจว่าจะเจรจาหรือหาเจ้าใหม่ในหมวดไหนก่อน',
      category: 'Price Change',
      report_source: 'purchase-analysis',
      chart_type: 'bar',
      config: {
        size: 'half',
        ...byProduct,
        group_by_field: ['category_name'],
        value: sum('extra_paid'),
        sort: 'abs_desc',
        color_mode: 'signed_cost',
        top_n: 10,
        format: 'currency',
      },
    },
    {
      // Cross-report: recipes carry an ingredient cost; purchases carry what
      // the kitchen pays now. When the recipe lags the purchase price, every
      // food-cost number built on the recipe reads low.
      template_key: 'pc_stale_recipe_cost',
      name: 'ต้นทุนในสูตรที่ล้าหลังราคาซื้อจริง',
      description: 'ราคาต่อหน่วยที่สูตรอาหารใช้คิดต้นทุน เทียบกับราคาที่ซื้อล่าสุด ถ้าสูตรยังใช้ราคาเก่า food cost ที่เห็นจะต่ำกว่าความจริง',
      category: 'Price Change',
      report_source: 'purchase-analysis',
      chart_type: 'table',
      config: {
        size: 'full',
        sources: [
          { as: 'p', source: 'purchase-analysis' },
          { as: 'r', source: 'menu-costing' },
        ],
        pivot: {
          key_field: 'product_code',
          key: { p: 'product_code', r: 'ingredient_code' },
          columns: [
            { field: 'product_name', from: 'p', first: 'product_name' },
            { field: 'buy_uom', from: 'p', latest: { value: 'uom', by: 'order_date' } },
            { field: 'last_price', from: 'p', latest: { value: 'price', by: 'order_date' } },
            { field: 'recipe_uom', from: 'r', first: 'ingredient_uom' },
            { field: 'recipe_qty', from: 'r', metric: sum('ingredient_qty') },
            { field: 'recipe_cost', from: 'r', metric: sum('cost') },
            { field: 'menus', from: 'r', metric: { op: 'count_distinct', field: 'menu_name' } },
          ],
        },
        derived: [
          { field: 'recipe_unit_cost', expr: { op: 'div', a: 'recipe_cost', b: 'recipe_qty' } },
          {
            field: 'gap_pct',
            expr: { op: 'pct_of', a: { op: 'sub', a: 'last_price', b: { op: 'div', a: 'recipe_cost', b: 'recipe_qty' } }, b: { op: 'div', a: 'recipe_cost', b: 'recipe_qty' } },
          },
        ],
        row_filter: {
          op: 'and',
          rules: [
            { op: 'gt', a: 'p_rows', b: 0 },
            { op: 'gt', a: 'r_rows', b: 0 },
            { op: 'gt', a: 'recipe_qty', b: 0 },
            { op: 'gte', a: { op: 'abs', a: 'gap_pct' }, b: 5 },
          ],
        },
        empty_message: 'ต้นทุนในสูตรใกล้เคียงราคาซื้อล่าสุดทุกตัว (ต่างไม่เกิน 5%)',
        sort_by: { field: 'gap_pct', dir: 'desc' },
        columns: [
          { field: 'product_code', label: 'รหัส' },
          { field: 'product_name', label: 'วัตถุดิบ' },
          { field: 'recipe_unit_cost', label: 'ราคาในสูตร / หน่วย', format: 'currency' },
          { field: 'recipe_uom', label: 'หน่วยในสูตร' },
          { field: 'last_price', label: 'ซื้อล่าสุด / หน่วย', format: 'currency' },
          { field: 'buy_uom', label: 'หน่วยซื้อ' },
          { field: 'gap_pct', label: 'สูตรต่ำกว่าจริง', format: 'pct_signed' },
          { field: 'menus', label: 'เมนูที่ใช้', format: 'number' },
        ],
        top_n: 200,
        foot: 'ถ้าหน่วยในสูตรกับหน่วยซื้อไม่เหมือนกัน (เช่น กรัม กับ กิโลกรัม) ส่วนต่างจะผิดเป็นหลักพันเท่า ให้ดูสองคอลัมน์หน่วยก่อนอ่านตัวเลข',
      },
    },
  ];
}

function avtTemplates() {
  // Used more than the recipes say, valued. FMH's own sign convention for
  // variance is not documented, so the direction comes from the quantities
  // and only the unit value comes from variance_value / variance_qty.
  const overuseValue = {
    op: 'sum_where',
    where: { op: 'differs', a: 'variance_qty', b: 0 },
    expr: {
      op: 'mul',
      a: { op: 'sub', a: 'actual_usage', b: 'theoretical_usage' },
      b: { op: 'div', a: { op: 'abs', a: 'variance_value' }, b: { op: 'abs', a: 'variance_qty' } },
    },
  };
  const byProduct = {
    sources: [
      { as: 'v', source: 'product-variance' },
      { as: 'w', source: 'wastage-lines' },
    ],
    pivot: {
      key_field: 'line_key',
      key: { v: { fields: ['sku', 'branch'] }, w: { fields: ['product_code', 'branch'] } },
      columns: [
        { field: 'product', from: 'v', first: 'product' },
        { field: 'category', from: 'v', first: 'category' },
        { field: 'branch', from: 'v', first: 'branch' },
        { field: 'uom', from: 'v', first: 'uom' },
        { field: 'theoretical', from: 'v', metric: sum('theoretical_usage') },
        { field: 'actual', from: 'v', metric: sum('actual_usage') },
        { field: 'overuse_value', from: 'v', metric: overuseValue },
        { field: 'waste_value', from: 'w', metric: sum('wastage_value') },
      ],
    },
    derived: [
      { field: 'variance_pct', expr: { op: 'pct_of', a: { op: 'sub', a: 'actual', b: 'theoretical' }, b: 'theoretical' } },
      { field: 'unexplained', expr: { op: 'sub', a: 'overuse_value', b: 'waste_value' } },
      // For the stack: of the overuse, how much the recorded waste covers.
      { field: 'unexplained_pos', expr: { op: 'max0', a: { op: 'sub', a: 'overuse_value', b: 'waste_value' } } },
      { field: 'explained_pos', expr: { op: 'sub', a: { op: 'max0', a: 'overuse_value' }, b: { op: 'max0', a: { op: 'sub', a: 'overuse_value', b: 'waste_value' } } } },
    ],
  };
  return [
    {
      template_key: 'avt_summary',
      name: 'ต้นทุนวัตถุดิบ: ตามสูตร เทียบ ใช้จริง',
      description: 'มูลค่าที่ควรใช้ตามยอดขายและสูตร เทียบกับที่ใช้ไปจริง ส่วนต่างหักของเสียที่บันทึกแล้ว เหลือคือส่วนที่ยังหาสาเหตุไม่ได้',
      category: 'Actual vs Theoretical',
      report_source: 'product-variance',
      chart_type: 'kpi',
      config: {
        size: 'full',
        sources: [
          { as: 'th', source: 'avt-theoretical-stat' },
          { as: 'ac', source: 'avt-actual-stat' },
          { as: 'w', source: 'wastage-lines' },
        ],
        pivot: {
          key_field: 'period',
          key: { th: { const: 'all' }, ac: { const: 'all' }, w: { const: 'all' } },
          columns: [
            { field: 'theoretical', from: 'th', metric: sum('theoretical_usage_value') },
            { field: 'actual', from: 'ac', metric: sum('actual_usage_value') },
            { field: 'waste', from: 'w', metric: sum('wastage_value') },
          ],
        },
        metrics: [
          { label: 'ตามสูตร (ควรใช้)', format: 'currency', value: sum('theoretical') },
          { label: 'ใช้จริง', format: 'currency', value: sum('actual') },
          { label: 'ส่วนต่าง', format: 'currency', value: { op: 'diff', a: sum('actual'), b: sum('theoretical') } },
          { label: 'ส่วนต่าง % ของตามสูตร', format: 'pct', value: { op: 'ratio_pct', a: { op: 'diff', a: sum('actual'), b: sum('theoretical') }, b: sum('theoretical') } },
          { label: 'ของเสียที่บันทึก', format: 'currency', value: sum('waste') },
          { label: 'อธิบายไม่ได้', format: 'currency', value: { op: 'diff', a: { op: 'diff', a: sum('actual'), b: sum('theoretical') }, b: sum('waste') } },
        ],
        foot: 'ทั้งช่วงที่ซิงก์ล่าสุด (80 วัน) · ใช้จริงต้องมีการนับสต็อกใน FMH ถ้าไม่ได้นับ ตัวเลขใช้จริงจะไม่สะท้อนความจริง',
      },
    },
    {
      template_key: 'avt_explained_by_category',
      name: 'ส่วนที่ใช้เกินสูตร: อธิบายได้ด้วยของเสีย หรืออธิบายไม่ได้',
      description: 'แต่ละหมวด แท่งคือมูลค่าที่ใช้เกินสูตร ส่วนสีทองคือของเสียที่มีคนบันทึกไว้ ส่วนสีแดงคือส่วนที่ยังไม่มีใครอธิบาย',
      category: 'Actual vs Theoretical',
      report_source: 'product-variance',
      chart_type: 'stack',
      config: {
        size: 'full',
        ...byProduct,
        group_by_field: ['category'],
        segments: [
          { label: 'ของเสียที่บันทึก', color: '#A9812F', value: sum('explained_pos') },
          { label: 'อธิบายไม่ได้', color: '#BE4229', value: sum('unexplained_pos') },
        ],
        format: 'currency',
        top_n: 10,
        empty_message: 'ไม่มีหมวดที่ใช้เกินสูตร',
        foot: 'นับเฉพาะสินค้าที่ใช้จริงมากกว่าสูตร · ทั้งช่วงที่ซิงก์ล่าสุด (80 วัน)',
      },
    },
    {
      template_key: 'avt_items',
      name: 'วัตถุดิบที่ใช้เกินสูตร รายสาขา',
      description: 'รายการที่ใช้จริงต่างจากสูตรมากที่สุด พร้อมของเสียที่บันทึกไว้ เรียงตามส่วนที่อธิบายไม่ได้ ใช้ตามหาว่าครัวไหน ตักเกินหรือของหายตรงไหน',
      category: 'Actual vs Theoretical',
      report_source: 'product-variance',
      chart_type: 'table',
      config: {
        size: 'full',
        ...byProduct,
        row_filter: {
          op: 'and',
          rules: [
            { op: 'gt', a: 'v_rows', b: 0 },
            { op: 'differs', a: 'overuse_value', b: 0, tolerance: 1 },
          ],
        },
        empty_message: 'การใช้จริงตรงกับสูตรทุกรายการ',
        sort_by: { field: 'unexplained', dir: 'desc' },
        columns: [
          { field: 'product', label: 'วัตถุดิบ' },
          { field: 'category', label: 'หมวด' },
          { field: 'branch', label: 'สาขา' },
          { field: 'uom', label: 'หน่วย' },
          { field: 'theoretical', label: 'ตามสูตร', format: 'number' },
          { field: 'actual', label: 'ใช้จริง', format: 'number' },
          { field: 'variance_pct', label: 'ต่าง', format: 'pct_signed' },
          { field: 'overuse_value', label: 'ใช้เกิน (฿)', format: 'currency' },
          { field: 'waste_value', label: 'ของเสียที่บันทึก', format: 'currency' },
          { field: 'unexplained', label: 'อธิบายไม่ได้', format: 'currency' },
        ],
        top_n: 200,
        foot: 'ติดลบ = ใช้น้อยกว่าสูตร มักแปลว่าสูตรตั้งปริมาณไว้มากเกินจริง หรือนับสต็อกเกิน · จับคู่ของเสียด้วยรหัสสินค้า + สาขา',
      },
    },
  ];
}

const BUILTIN_TEMPLATES = [
  // ---------- Purchasing (FMH purchase_analysis) ----------
  {
    template_key: 'pa_kpis',
    name: 'สรุปยอด PO / GRN / Invoice',
    description: 'ยอดรวม PO, GRN, Invoice และ % ส่วนต่างระหว่างกัน',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'kpi',
    config: {
      size: 'full',
      metrics: [
        { label: 'Total PO value', format: 'currency', value: sum('po_total') },
        { label: 'Total GRN value', format: 'currency', value: sum('grn_total') },
        { label: 'Total Invoice value', format: 'currency', value: sum('invoice_total') },
        { label: 'GRN vs PO', format: 'pct_signed', value: { op: 'pct_change', from: sum('po_total'), to: sum('grn_total') } },
        { label: 'Invoice vs GRN', format: 'pct_signed', value: { op: 'pct_change', from: sum('grn_total'), to: sum('invoice_total') } },
      ],
    },
  },
  {
    template_key: 'pa_trend',
    name: 'PO vs GRN vs Invoice ตามเวลา',
    description: 'กราฟเส้นรายสัปดาห์ เทียบมูลค่า PO, GRN และ Invoice',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'line',
    config: {
      size: 'full',
      date_fields: ['order_date', 'issued_date', 'grn_date', 'invoice_date'],
      bucket: 'week',
      format: 'currency',
      series: [
        { label: 'PO', value: sum('po_total'), color: '#A9812F' },
        { label: 'GRN', value: sum('grn_total'), color: '#2F6FB0' },
        { label: 'Invoice', value: sum('invoice_total'), color: '#BE4229' },
      ],
    },
  },
  {
    template_key: 'pa_attention_products',
    name: 'สินค้าที่ต้องจับตา (GRN ต่างจาก PO)',
    description: 'สินค้าที่มูลค่า GRN ต่างจาก PO มากที่สุด',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'third',
      group_by: ['product_name', 'product_code'],
      value: { op: 'pct_change', from: sum('po_total'), to: sum('grn_total') },
      rank_by: { op: 'diff', a: sum('grn_total'), b: sum('po_total') },
      sort: 'abs_desc',
      top_n: 10,
      format: 'pct_signed',
      color_mode: 'signed',
    },
  },
  {
    template_key: 'pa_top_suppliers',
    name: 'Top supplier ตามยอด PO',
    description: 'ซัพพลายเออร์ที่มียอดสั่งซื้อสูงสุด',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'third',
      group_by: ['supplier'],
      value: sum('po_total'),
      sort: 'desc',
      top_n: 10,
      format: 'currency',
      color: '#2F6FB0',
    },
  },
  {
    template_key: 'pa_category_variance',
    name: 'ส่วนต่าง GRN vs PO ตามหมวดหมู่',
    description: 'หมวดหมู่ที่ใช้จ่ายมากที่สุด พร้อม % ส่วนต่าง GRN เทียบ PO',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'third',
      group_by: ['category_name'],
      value: { op: 'pct_change', from: sum('po_total'), to: sum('grn_total') },
      rank_by: sum('po_total'),
      sort: 'desc',
      top_n: 10,
      format: 'pct_signed',
      color_mode: 'signed',
    },
  },
  {
    template_key: 'pa_table',
    name: 'ตารางข้อมูลจัดซื้อ (ละเอียด)',
    description: 'ข้อมูลดิบจาก purchase analysis พร้อม export',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: { size: 'full', top_n: 200 },
  },

  // ---------- Menu costing (FMH menu_and_ingredients) ----------
  {
    template_key: 'mc_kpis',
    name: 'สรุปต้นทุนสูตรอาหาร',
    description: 'ต้นทุนสูตรรวม จำนวนเมนู วัตถุดิบ และค่าเฉลี่ยวัตถุดิบต่อเมนู',
    category: 'Menu Costing',
    report_source: 'menu-costing',
    chart_type: 'kpi',
    config: {
      size: 'full',
      metrics: [
        { label: 'Total recipe cost', format: 'currency', value: sum('total_cost') },
        { label: 'Menus', format: 'number', value: { op: 'count_distinct', field: MENU } },
        { label: 'Distinct ingredients', format: 'number', value: { op: 'count_distinct', field: INGREDIENT } },
        {
          label: 'Avg ingredients / menu',
          format: 'decimal1',
          value: { op: 'div', a: { op: 'count' }, b: { op: 'count_distinct', field: MENU } },
        },
      ],
    },
  },
  {
    template_key: 'mc_top_ingredients',
    name: 'วัตถุดิบที่กระทบต้นทุนมากที่สุด',
    description: 'วัตถุดิบเรียงตามต้นทุนรวมทุกเมนู พร้อมจำนวนเมนูที่ใช้',
    category: 'Menu Costing',
    report_source: 'menu-costing',
    chart_type: 'bar',
    config: {
      size: 'full',
      group_by: INGREDIENT,
      value: sum('total_cost'),
      sort: 'desc',
      top_n: 12,
      format: 'currency',
      color: '#BE4229',
      label_extra: { value: { op: 'count_distinct', field: MENU }, suffix: ' เมนู' },
    },
  },
  {
    template_key: 'mc_top_menus',
    name: 'เมนูต้นทุนสูงสุด',
    description: 'เมนูเรียงตามต้นทุนสูตรรวม',
    category: 'Menu Costing',
    report_source: 'menu-costing',
    chart_type: 'bar',
    config: { size: 'half', group_by: MENU, value: sum('total_cost'), sort: 'desc', top_n: 10, format: 'currency', color: '#A9812F' },
  },
  {
    template_key: 'mc_sensitivity',
    name: 'Ingredient price sensitivity',
    description: 'ถ้าราคาวัตถุดิบขยับ X% ต้นทุนเมนูที่ใช้วัตถุดิบนั้นขยับกี่ %',
    category: 'Menu Costing',
    report_source: 'menu-costing',
    chart_type: 'sensitivity',
    config: { size: 'half', top_n: 10, default_pct: 10 },
  },
  {
    template_key: 'mc_menu_breakdown',
    name: 'มุมมองรายเมนู — วัตถุดิบไหนคุมต้นทุน',
    description: 'เลือกเมนู ดูสัดส่วนต้นทุนวัตถุดิบ และผลกระทบถ้าราคาวัตถุดิบขยับ',
    category: 'Menu Costing',
    report_source: 'menu-costing',
    chart_type: 'menu_breakdown',
    config: { size: 'full', top_n: 10, default_pct: 10 },
  },

  // ---------- COGS (FMH cogs) ----------
  {
    template_key: 'cogs_kpis',
    name: 'สรุปยอดขาย / COGS / กำไรขั้นต้น',
    description: 'ยอดขาย ต้นทุน กำไรขั้นต้น และ gross margin',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'kpi',
    config: {
      size: 'full',
      metrics: [
        { label: 'Total sales', format: 'currency', value: sum('total_sales') },
        { label: 'Total COGS', format: 'currency', value: sum('total_cost') },
        { label: 'Gross profit', format: 'currency', value: sum('gross_profit') },
        { label: 'Gross margin', format: 'pct', value: { op: 'ratio_pct', a: sum('gross_profit'), b: sum('total_sales') } },
      ],
    },
  },
  {
    template_key: 'cogs_lowest_margin',
    name: 'เมนูมาร์จิ้นต่ำสุด',
    description: 'เมนูที่ gross margin ต่ำที่สุด',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: ['menu_name', 'sku'],
      value: { op: 'ratio_pct', a: sum('gross_profit'), b: sum('total_sales') },
      sort: 'asc',
      top_n: 10,
      format: 'pct',
      color_mode: 'margin',
    },
  },
  {
    template_key: 'cogs_margin_by_branch',
    name: 'Gross margin ตามสาขา',
    description: 'เปรียบเทียบ gross margin ของแต่ละสาขา',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: ['branch_name'],
      value: { op: 'ratio_pct', a: sum('gross_profit'), b: sum('total_sales') },
      sort: 'desc',
      top_n: 20,
      format: 'pct',
      color_mode: 'margin',
    },
  },
  {
    template_key: 'cogs_table',
    name: 'ตาราง COGS (ละเอียด)',
    description: 'ข้อมูลดิบจากรายงาน COGS พร้อม export',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'table',
    config: { size: 'full', top_n: 200 },
  },

  // ---------- Sales (FMH order_items_by_branch) ----------
  {
    template_key: 'sb_table',
    name: 'ตาราง Order Items by Branch',
    description: 'รายการสั่งของแต่ละสาขา (ข้อมูลดิบ) พร้อม export',
    category: 'Sales',
    report_source: 'sales-by-branch',
    chart_type: 'table',
    config: { size: 'full', top_n: 200 },
  },
// ---------- Batch 1: FMH cards and server-side groupings ----------
  //
  // These read either a card FMH has already aggregated, or a card with
  // group_by so FMH does the grouping. Both cost a handful of rows against the
  // monthly quota instead of the thousands an itemized pull costs, which is the
  // constraint that actually limits how many widgets a client can run.
  //
  // Eight of them share one pull (cogs grouped by menu), so a dashboard built
  // from those costs exactly one request no matter how many of them it shows.

  // --- COGS: cards ---
  {
    template_key: 'cogs_overview',
    name: 'สรุป COGS และกำไรขั้นต้น',
    description: 'ยอดขาย ต้นทุนขาย กำไรขั้นต้น และ COGS % ที่ FMH สรุปมาให้แล้ว',
    category: 'Cost Control',
    report_source: 'cogs-stat',
    chart_type: 'kpi',
    config: {
      size: 'full',
      metrics: [
        { label: 'ยอดขาย', format: 'currency', value: sum('total_sales') },
        { label: 'ต้นทุนขาย', format: 'currency', value: sum('total_cogs') },
        { label: 'กำไรขั้นต้น', format: 'currency', value: sum('gross_profit') },
        { label: 'COGS %', format: 'pct', value: sum('cogs_percentage') },
      ],
    },
  },
  {
    template_key: 'cogs_trend',
    name: 'ยอดขาย ต้นทุน กำไร ตามเวลา',
    description: 'สามเส้นตามงวด เห็นว่ากำไรที่หายไปมาจากยอดขายตกหรือต้นทุนขึ้น',
    category: 'Cost Control',
    report_source: 'cogs-trend',
    chart_type: 'line',
    config: {
      size: 'full',
      date_fields: ['period'],
      bucket: 'day', // each row is already one period; don't re-bucket it
      format: 'currency',
      series: [
        { label: 'ยอดขาย', value: sum('sales'), color: '#A9812F' },
        { label: 'ต้นทุนขาย', value: sum('cogs'), color: '#2F6FB0' },
        { label: 'กำไรขั้นต้น', value: sum('gross_profit'), color: '#BE4229' },
      ],
    },
  },
  {
    template_key: 'cogs_low_margin',
    name: 'เมนูมาร์จิ้นต่ำสุด',
    description: 'เมนูที่ gross margin ต่ำที่สุด เทียบเส้นเป้าของร้าน',
    category: 'Cost Control',
    report_source: 'cogs-low-margin',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: ['menu_name'],
      value: sum('gross_margin_percentage'),
      sort: 'asc',
      top_n: 10,
      format: 'pct',
      threshold: 60,
      lower_is_better: false,
    },
  },

  // --- COGS: one grouped pull, eight widgets ---
  {
    template_key: 'cogs_yield_loss',
    name: 'ต้นทุนที่หายไปกับ yield loss',
    description: 'เมนูที่สูญเสียต้นทุนจากการตัดแต่งและของเหลือมากที่สุด เป็นบาท',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'menu',
      group_by_field: ['menu_name'],
      value: sum('total_yield_loss_cost'),
      sort: 'desc',
      top_n: 10,
      format: 'currency',
      color: '#BE4229',
    },
  },
  {
    template_key: 'cogs_menu_gp',
    name: 'กำไรขั้นต้นเป็นบาท เรียงอันดับ',
    description: 'เมนูเรียงตามกำไรเป็นบาท พร้อมเส้นสะสมบอกว่ากี่เมนูแรกสร้างกำไร 80%',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'pareto',
    config: {
      size: 'full',
      group_by: 'menu',
      group_by_field: ['menu_name'],
      value: sum('gross_profit'),
      sort: 'desc',
      top_n: 12,
      format: 'currency',
      bar_label: 'กำไรขั้นต้น',
    },
  },
  {
    template_key: 'cogs_menu_table',
    name: 'เมนูที่ควรปรับราคา',
    description: 'ทุกเมนูพร้อมจำนวนที่ขาย ราคาขายเฉลี่ย ต้นทุนต่อหน่วย และ COGS % — เรียงและ export ได้',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'table',
    config: { size: 'full', group_by: 'menu', top_n: 200 },
  },
  {
    template_key: 'cogs_branch_league',
    name: 'อันดับ COGS ตามสาขา',
    description: 'เมนูชุดเดียวกันแต่ COGS ต่างกัน แปลว่าปัญหาอยู่ที่การคุมของในครัวของสาขานั้น',
    category: 'Branch',
    report_source: 'cogs',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'branch',
      group_by_field: ['branch_name'],
      value: sum('cogs_percentage'),
      sort: 'desc',
      top_n: 20,
      format: 'pct',
      threshold: 34,
    },
  },

  // --- Purchasing ---
  {
    template_key: 'pa_supplier_spend',
    name: 'ยอดซื้อตามซัพพลายเออร์',
    description: 'FMH รวมยอดต่อซัพพลายเออร์ให้แล้ว คืนมาแถวเดียวต่อเจ้า ไม่ใช่แถวเดียวต่อบรรทัดสั่งซื้อ',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'supplier',
      group_by_field: ['supplier'],
      value: sum('total_spend'),
      sort: 'desc',
      top_n: 12,
      format: 'currency',
      color: '#2F6FB0',
      label_extra: { value: sum('order_count'), suffix: ' ใบ' },
    },
  },
  {
    template_key: 'price_variance_top',
    name: 'สินค้าที่ราคาต่างกันมากที่สุดระหว่างเจ้า',
    description: 'ตัวบนสุดคือจุดที่ประหยัดได้ทันทีโดยแค่ย้ายไปสั่งจากอีกเจ้า',
    category: 'Purchasing',
    report_source: 'price-variance-top',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: ['product'],
      value: sum('variance_pct'),
      sort: 'desc',
      top_n: 10,
      format: 'pct',
      color: '#BE4229',
    },
  },
  {
    template_key: 'price_avg_trend',
    name: 'ราคาเฉลี่ยที่จ่ายจริงตามเวลา',
    description: 'ใช้ตอบว่าต้นทุนขึ้นจริงไหม และอ้างอิงเวลาซัพพลายเออร์บอกว่าของขึ้นทั้งตลาด',
    category: 'Purchasing',
    report_source: 'price-avg-trend',
    chart_type: 'line',
    config: {
      size: 'half',
      date_fields: ['period'],
      bucket: 'day',
      format: 'currency',
      series: [{ label: 'ราคาเฉลี่ย', value: sum('avg_price'), color: '#2F6FB0' }],
    },
  },
  {
    template_key: 'credit_note_by_supplier',
    name: 'ใบลดหนี้ตามซัพพลายเออร์',
    description: 'เจ้าที่ต้องออกใบลดหนี้บ่อยคือเจ้าที่สร้างต้นทุนแฝงให้ทีม แม้ราคาต่อหน่วยจะดูถูก',
    category: 'Purchasing',
    report_source: 'credit-notes',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'supplier',
      group_by_field: ['supplier'],
      value: sum('total_amount'),
      sort: 'desc',
      top_n: 10,
      format: 'currency',
      color: '#BE4229',
      label_extra: { value: sum('credit_note_count'), suffix: ' ใบ' },
    },
  },

  // --- Menu usage ---
  {
    template_key: 'menu_ingredient_usage',
    name: 'วัตถุดิบที่ถูกใช้จริงตามยอดขาย',
    description: 'ถ่วงน้ำหนักด้วยยอดขายจริงแล้ว วัตถุดิบในสูตรแพงที่ไม่มีใครสั่งจะไม่ขึ้นมาหลอก',
    category: 'Menu Costing',
    report_source: 'menu-usage-top',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: ['ingredient'],
      value: sum('total_cost'),
      sort: 'desc',
      top_n: 12,
      format: 'currency',
      color: '#BE4229',
    },
  },

  // --- Stock & wastage ---
  {
    template_key: 'stock_flow',
    name: 'ของเข้าออกตามมูลค่า',
    description: 'ถ้าเส้นเข้าสูงกว่าเส้นออกต่อเนื่อง สต็อกกำลังพอกขึ้น ซึ่งเป็นเงินจมและความเสี่ยงของหมดอายุ',
    category: 'Stock',
    report_source: 'stock-flow',
    chart_type: 'line',
    config: {
      size: 'half',
      date_fields: ['period'],
      bucket: 'day',
      format: 'currency',
      series: [
        { label: 'เข้า', value: sum('value_in'), color: '#2F6FB0' },
        { label: 'ออก', value: sum('value_out'), color: '#A9812F' },
      ],
    },
  },
  {
    template_key: 'wastage_trend',
    name: 'ของเสียตามเวลา',
    description: 'ของเสียคือกำไรที่หายไปตรง ๆ และเป็นตัวเลขที่สื่อสารกับทีมหน้าร้านได้ง่ายที่สุด',
    category: 'Stock',
    report_source: 'wastage-trend',
    chart_type: 'line',
    config: {
      size: 'half',
      date_fields: ['period'],
      bucket: 'day',
      format: 'currency',
      series: [{ label: 'มูลค่าของเสีย', value: sum('total_wastage_value'), color: '#BE4229' }],
    },
  },
  {
    template_key: 'wastage_top_products',
    name: 'ของเสียมากที่สุด รายสินค้า',
    description: 'ชี้จุดที่แก้แล้วเห็นผลทันที',
    category: 'Stock',
    report_source: 'wastage-top-products',
    chart_type: 'bar',
    config: { size: 'third', group_by: ['product'], value: sum('total_wastage_value'), sort: 'desc', top_n: 10, format: 'currency', color: '#BE4229' },
  },
  {
    template_key: 'wastage_top_branches',
    name: 'ของเสียมากที่สุด รายสาขา',
    description: 'ดูคู่กับปริมาณที่สาขารับไป เพราะตัวเลขดิบจะทำให้สาขาใหญ่ดูแย่เสมอ',
    category: 'Branch',
    report_source: 'wastage-top-branches',
    chart_type: 'bar',
    config: { size: 'third', group_by: ['branch'], value: sum('total_wastage_value'), sort: 'desc', top_n: 10, format: 'currency', color: '#BE4229' },
  },
  {
    template_key: 'stock_count_variance',
    name: 'ผลการนับสต็อก',
    description: 'ส่วนต่างระหว่างยอดในระบบกับยอดที่นับได้จริง ถ้าตัวนี้แดงตลอด ตัวเลขต้นทุนทุกตัวก็ยังเชื่อไม่ได้',
    category: 'Stock',
    report_source: 'stock-count',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'product',
      group_by_field: ['product'],
      value: sum('variance_value'),
      sort: 'abs_desc',
      top_n: 12,
      format: 'currency',
      color_mode: 'signed',
      label_extra: { value: sum('times_counted'), suffix: ' ครั้ง' },
    },
  },
  {
    template_key: 'batch_remaining',
    name: 'ของค้างในล็อต',
    description: 'สัดส่วนที่ยังเหลือเทียบกับที่รับเข้ามา สูงผิดปกติแปลว่าไม่ได้ใช้ของตามลำดับเข้าก่อนออกก่อน',
    category: 'Stock',
    report_source: 'batch',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'product',
      group_by_field: ['product'],
      value: { op: 'ratio_pct', a: sum('total_remaining_qty'), b: sum('total_received_qty') },
      rank_by: sum('total_remaining_qty'),
      sort: 'desc',
      top_n: 10,
      format: 'pct',
      color: '#A9812F',
      label_extra: { value: sum('batch_count'), suffix: ' ล็อต' },
    },
  },

  // --- Central kitchen ---
  {
    template_key: 'avt_variance',
    name: 'ใช้จริงเทียบใช้ตามสูตร',
    description: 'มูลค่าส่วนต่างระหว่างวัตถุดิบที่ควรใช้ตามสูตรกับที่ใช้ไปจริง FMH คำนวณจากสต็อกจริงให้แล้ว',
    category: 'Cost Control',
    report_source: 'avt-stat',
    chart_type: 'kpi',
    config: {
      size: 'third',
      metrics: [{ label: 'ส่วนต่างการใช้วัตถุดิบ', format: 'currency', value: sum('variance_value') }],
    },
  },
  {
    template_key: 'production_yield',
    name: 'yield ของรอบผลิต',
    description: 'ผลผลิตจริงเทียบแผน ตั้งเป้าต่อสินค้า ไม่ใช่เป้าเดียวทั้งครัว',
    category: 'Cost Control',
    report_source: 'production',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'product',
      group_by_field: ['product'],
      value: sum('yield_pct'),
      sort: 'asc',
      top_n: 12,
      format: 'pct',
      threshold: 90,
      lower_is_better: false,
      label_extra: { value: sum('production_count'), suffix: ' รอบ' },
    },
  },
  {
    template_key: 'picking_fill_rate',
    name: 'จัดของได้ครบตามที่สาขาขอ',
    description: 'fill rate ที่สาขารู้สึกจริง วัดผลงานครัวกลางเอง ถ้าต่ำสาขาจะเริ่มสั่งเผื่อ',
    category: 'Branch',
    report_source: 'picking',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'branch',
      group_by_field: ['branch'],
      value: sum('picked_pct'),
      sort: 'asc',
      top_n: 20,
      format: 'pct',
      threshold: 95,
      lower_is_better: false,
    },
  },
  {
    template_key: 'picking_trend',
    name: 'งานจัดของตามเวลา',
    description: 'ช่องว่างระหว่างที่สาขาขอกับที่จัดได้คืองานที่ค้าง ซึ่งแปลเป็นของที่สาขาจะไม่ได้ตามกำหนด',
    category: 'Branch',
    report_source: 'picking-trend',
    chart_type: 'line',
    config: {
      size: 'half',
      date_fields: ['period'],
      bucket: 'day',
      format: 'number',
      series: [
        { label: 'สาขาขอ', value: sum('requested_qty'), color: '#A9812F' },
        { label: 'จัดได้', value: sum('picked_qty'), color: '#2F6FB0' },
      ],
    },
  },
  {
    template_key: 'branch_order_volume',
    name: 'ปริมาณที่แต่ละสาขาสั่ง',
    description: 'ครัวกลางใช้วางแผนกำลังผลิตและรอบรถส่ง',
    category: 'Sales',
    report_source: 'branch-order-top',
    chart_type: 'bar',
    config: { size: 'half', group_by: ['branch'], value: sum('total_quantity'), sort: 'desc', top_n: 15, format: 'number', color: '#2F6FB0' },
  },
// --- Needs the chart types added alongside these ---
  {
    template_key: 'menu_matrix',
    name: 'เมทริกซ์ menu engineering',
    description: 'แบ่งเมนูเป็นสี่กลุ่มตามความนิยมและกำไรต่อจาน เส้นตัดคำนวณจากเมนูที่แสดงอยู่จริง',
    category: 'Menu Costing',
    report_source: 'cogs',
    chart_type: 'scatter',
    config: {
      size: 'full',
      group_by: 'menu',
      group_by_field: ['menu_name'],
      x: sum('total_quantity'),
      x_share: true, // ส่วนแบ่งจำนวนจานของเมนูที่แสดงอยู่
      x_label: 'ส่วนแบ่งจำนวนจาน %',
      x_format: 'pct',
      y: { op: 'div', a: sum('gross_profit'), b: sum('total_quantity') },
      y_label: 'กำไรต่อจาน',
      y_format: 'currency',
      // กฎ 70% ของ Kasavana & Smith: (100 ÷ จำนวนเมนู) × 0.70
      qx: { op: 'share_rule', factor: 0.7 },
      qy: { op: 'mean' },
      quadrant_labels: ['ดาวเด่น', 'กำไรดีแต่ขายน้อย', 'ขายดีกำไรบาง', 'ควรทบทวน'],
    },
  },
  {
    template_key: 'menu_mix_qty',
    name: 'สัดส่วนจำนวนจานที่ขาย',
    description: 'พื้นที่กล่องแทนสัดส่วนจำนวนจาน บอกภาระงานครัวจริง ต่างจากสัดส่วนยอดขาย',
    category: 'Menu Costing',
    report_source: 'cogs',
    chart_type: 'treemap',
    config: { size: 'half', group_by: 'menu', group_by_field: ['menu_name'], value: sum('total_quantity'), top_n: 10, format: 'number' },
  },
  {
    template_key: 'menu_price_vs_cost',
    name: 'ราคาขายเทียบต้นทุนต่อหน่วย',
    description: 'ระยะห่างจากเส้นทแยงคือกำไรต่อจาน เมนูที่อยู่ใกล้เส้นคือเมนูที่เกือบไม่เหลืออะไร',
    category: 'Menu Costing',
    report_source: 'cogs',
    chart_type: 'scatter',
    config: {
      size: 'half',
      group_by: 'menu',
      group_by_field: ['menu_name'],
      x: sum('average_unit_cost'),
      x_label: 'ต้นทุนต่อหน่วย',
      x_format: 'currency',
      y: sum('average_selling_price'),
      y_label: 'ราคาขายเฉลี่ย',
      y_format: 'currency',
    },
  },
  {
    template_key: 'price_compare_suppliers',
    name: 'เทียบราคาข้ามซัพพลายเออร์',
    description: 'สินค้าเดียวกันแต่ละเจ้าขายเท่าไร ช่วงที่กว้างคือจุดที่ประหยัดได้มากที่สุด',
    category: 'Purchasing',
    report_source: 'price-comparison',
    chart_type: 'range',
    config: {
      size: 'half',
      group_by: 'product',
      group_by_field: ['product'],
      min: sum('min_price'),
      max: sum('max_price'),
      last: sum('avg_price'),
      top_n: 10,
      format: 'currency',
      marker_label: 'เฉลี่ย',
      foot: 'แถบคือช่วงราคาระหว่างซัพพลายเออร์ของสินค้านั้น จุดเข้มคือราคาเฉลี่ยที่จ่ายจริง',
    },
  },
  {
    template_key: 'po_status_mix',
    name: 'สถานะใบสั่งซื้อ',
    description: 'สัดส่วนใบสั่งซื้อตามสถานะ ถ้ากลุ่มที่ยังไม่ปิดโตขึ้นแปลว่ากระบวนการติดก่อนถึงบัญชี',
    category: 'Purchasing',
    report_source: 'po-status',
    chart_type: 'donut',
    config: { size: 'half', group_by: ['status'], value: sum('order_count'), top_n: 8, format: 'number' },
  },
  {
    template_key: 'stock_value_by_category',
    name: 'มูลค่าสต็อกตามหมวด',
    description: 'เงินที่จมอยู่ในสต็อก หมวดที่กินสัดส่วนใหญ่ผิดปกติมักแปลว่าสั่งเกินหรือของค้าง',
    category: 'Stock',
    report_source: 'stock-by-category',
    chart_type: 'donut',
    config: { size: 'half', group_by: ['category'], value: sum('total_stock_value'), top_n: 8, format: 'currency' },
  },

  // ---------- Line checks (FMH purchase_analysis, itemized) ----------
  // Every template below reads the plain `purchase-analysis` pull the app has
  // synced since day one, so the whole group adds nothing to a company's
  // monthly row quota. That is deliberate: itemized is the expensive shape, so
  // the sixteen widgets share one pull instead of asking for sixteen.
  //
  // What itemized buys that a grouping cannot: a grouped row has already added
  // PO, GRN and invoice together, so a line where they disagree is invisible.
  // These widgets exist to find the disagreements.
  {
    template_key: 'ita_three_way_match',
    name: 'บรรทัดที่ PO / รับของ / ใบแจ้งหนี้ ไม่ตรงกัน',
    description: 'ตรวจสามทางรายบรรทัด — สั่งเท่าไร รับเท่าไร ถูกวางบิลเท่าไร เผื่อไว้ 1 บาทกันเศษปัดเศษ',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'full',
      derived: [
        { field: 'grn_minus_po', expr: { op: 'sub', a: { field: 'grn_total' }, b: { field: 'po_total' } } },
        { field: 'invoice_minus_grn', expr: { op: 'sub', a: { field: 'invoice_total' }, b: { field: 'grn_total' } } },
      ],
      // Only lines that have been through all three stages. A line still
      // waiting to be received has GRN 0, which "differs" from its PO without
      // anything being wrong — letting those in buries the real mismatches
      // under rows that are merely in progress, and those have their own two
      // widgets already.
      row_filter: {
        op: 'and',
        rules: [
          { op: 'present', field: 'grn_number' },
          { op: 'present', field: 'invoice_number' },
          {
            op: 'or',
            rules: [
              { op: 'differs', a: { field: 'grn_total' }, b: { field: 'po_total' }, tolerance: 1 },
              { op: 'differs', a: { field: 'invoice_total' }, b: { field: 'grn_total' }, tolerance: 1 },
            ],
          },
        ],
      },
      empty_message: 'ทุกบรรทัดที่ครบสามขั้นตอนแล้วตรงกันทั้ง PO รับของ และใบแจ้งหนี้',
      columns: [
        { field: 'po_number', label: 'PO' },
        { field: 'order_date', label: 'วันสั่ง' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'po_total', label: 'PO', format: 'currency' },
        { field: 'grn_total', label: 'รับของ', format: 'currency' },
        { field: 'invoice_total', label: 'ใบแจ้งหนี้', format: 'currency' },
        { field: 'grn_minus_po', label: 'รับ − สั่ง', format: 'currency' },
        { field: 'invoice_minus_grn', label: 'บิล − รับ', format: 'currency' },
      ],
      top_n: 200,
    },
  },
  {
    template_key: 'ita_overbilled',
    name: 'วางบิลเกินของที่รับจริง',
    description: 'รวมส่วนที่ใบแจ้งหนี้สูงกว่ามูลค่าของที่รับ แยกตามซัพพลายเออร์ — เงินที่ควรทวงคืน',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      derived: [{ field: 'overbilled', expr: { op: 'sub', a: { field: 'invoice_total' }, b: { field: 'grn_total' } } }],
      row_filter: { op: 'gt', a: { field: 'invoice_total' }, b: { field: 'grn_total' } },
      empty_message: 'ไม่มีบรรทัดไหนถูกวางบิลเกินของที่รับ',
      group_by_field: ['supplier'],
      value: { op: 'sum', field: 'overbilled' },
      top_n: 10,
      format: 'currency',
      foot: 'นับเฉพาะบรรทัดที่ใบแจ้งหนี้สูงกว่ามูลค่ารับของ',
    },
  },
  {
    template_key: 'ita_short_delivery',
    name: 'ส่งของขาด แยกตามซัพพลายเออร์',
    description: 'รวมจำนวนที่สั่งแล้วได้ไม่ครบ ตัวที่ขาดบ่อยคือตัวที่ทำให้ครัวต้องแก้เมนูหน้างาน',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      derived: [{ field: 'short_qty', expr: { op: 'sub', a: { field: 'po_qty' }, b: { field: 'grn_quantity' } } }],
      row_filter: {
        op: 'and',
        rules: [
          { op: 'present', field: 'grn_number' },
          { op: 'gt', a: { field: 'po_qty' }, b: { field: 'grn_quantity' } },
        ],
      },
      empty_message: 'ไม่มีบรรทัดที่ส่งขาด',
      group_by_field: ['supplier'],
      value: { op: 'sum', field: 'short_qty' },
      top_n: 10,
      format: 'number',
      foot: 'นับเฉพาะบรรทัดที่รับของแล้วและได้น้อยกว่าที่สั่ง',
    },
  },
  {
    template_key: 'ita_not_received',
    name: 'สั่งแล้วยังไม่ได้รับของ',
    description: 'บรรทัดที่มี PO แต่ยังไม่มีใบรับของ เรียงตามวันที่นัดส่ง',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'full',
      row_filter: { op: 'blank', field: 'grn_number' },
      empty_message: 'รับของครบทุกบรรทัดแล้ว',
      columns: [
        { field: 'requested_delivery_date', label: 'นัดส่ง' },
        { field: 'po_number', label: 'PO' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
        { field: 'branch', label: 'สาขา' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'po_qty', label: 'จำนวน', format: 'number' },
        { field: 'po_total', label: 'มูลค่า', format: 'currency' },
        { field: 'order_status', label: 'สถานะ' },
      ],
      top_n: 200,
    },
  },
  {
    template_key: 'ita_grn_not_invoiced',
    name: 'รับของแล้วแต่ยังไม่มีใบแจ้งหนี้',
    description: 'มูลค่าของที่รับเข้ามาแล้วแต่ซัพพลายเออร์ยังไม่วางบิล — ภาระที่ยังไม่เข้าบัญชี',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      row_filter: {
        op: 'and',
        rules: [
          { op: 'present', field: 'grn_number' },
          { op: 'blank', field: 'invoice_number' },
        ],
      },
      empty_message: 'ของที่รับแล้วถูกวางบิลครบทุกบรรทัด',
      group_by_field: ['supplier'],
      value: { op: 'sum', field: 'grn_total' },
      top_n: 10,
      format: 'currency',
      foot: 'ยอดนี้คือค่าใช้จ่ายที่เกิดแล้วแต่ยังไม่มีเอกสารตั้งหนี้',
    },
  },
  {
    template_key: 'ita_lead_time',
    name: 'ระยะเวลาส่งของเฉลี่ย แยกตามซัพพลายเออร์',
    description: 'นับจากวันสั่งถึงวันรับของจริง ใช้ตั้งรอบสั่งซื้อและจุดสั่งซ้ำ',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      derived: [{ field: 'lead_days', expr: { op: 'days', from: 'order_date', to: 'grn_date' } }],
      row_filter: { op: 'present', field: 'lead_days' },
      empty_message: 'ยังไม่มีบรรทัดที่มีทั้งวันสั่งและวันรับของ',
      group_by_field: ['supplier'],
      value: { op: 'avg', field: 'lead_days' },
      sort: 'desc',
      top_n: 10,
      format: 'decimal1',
      foot: 'หน่วยเป็นวัน นับเฉพาะบรรทัดที่รับของแล้ว',
    },
  },
  {
    template_key: 'ita_late_delivery',
    name: 'ส่งช้ากว่าที่นัด แยกตามซัพพลายเออร์',
    description: 'เฉลี่ยจำนวนวันที่รับของช้ากว่าวันนัด ค่าติดลบคือมาก่อนกำหนด',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      derived: [{ field: 'days_late', expr: { op: 'days', from: 'requested_delivery_date', to: 'grn_date' } }],
      row_filter: { op: 'present', field: 'days_late' },
      empty_message: 'ยังไม่มีบรรทัดที่มีทั้งวันนัดส่งและวันรับของ',
      group_by_field: ['supplier'],
      value: { op: 'avg', field: 'days_late' },
      sort: 'desc',
      top_n: 10,
      format: 'decimal1',
      color_mode: 'signed',
      foot: 'บวกคือช้ากว่านัด ลบคือมาก่อนนัด',
    },
  },
  {
    template_key: 'ita_price_dispersion',
    name: 'ราคาต่อหน่วยที่จ่ายจริง กว้างแค่ไหน',
    description: 'สินค้าตัวเดียวกันแต่ละบรรทัดจ่ายไม่เท่ากัน แถบยิ่งกว้างยิ่งควรไปคุยเรื่องราคา',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'range',
    config: {
      size: 'half',
      group_by_field: ['product_name', 'product_code'],
      min: { op: 'min', field: 'price' },
      max: { op: 'max', field: 'price' },
      last: { op: 'avg', field: 'price' },
      top_n: 12,
      format: 'currency',
      marker_label: 'เฉลี่ย',
      foot: 'แถบคือช่วงราคาต่อหน่วยที่เคยจ่ายของสินค้านั้น จุดเข้มคือราคาเฉลี่ย',
    },
  },
  {
    template_key: 'ita_price_gap_saving',
    name: 'ส่วนต่างราคาต่อหน่วย สูงสุด–ต่ำสุด',
    description: 'ถ้าซื้อได้ที่ราคาต่ำสุดทุกครั้ง จะประหยัดต่อหน่วยเท่าไร เรียงจากช่องว่างกว้างที่สุด',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by_field: ['product_name', 'product_code'],
      value: { op: 'diff', a: { op: 'max', field: 'price' }, b: { op: 'min', field: 'price' } },
      top_n: 12,
      format: 'currency',
      foot: 'ช่องว่างต่อหน่วย ไม่ใช่ยอดประหยัดรวม — ต้องคูณจำนวนที่ซื้อเองก่อนเอาไปคุย',
    },
  },
  {
    template_key: 'ita_uom_mix',
    name: 'สินค้าที่หน่วยนับไม่ตรงกัน',
    description: 'สินค้าตัวเดียวแต่ถูกบันทึกหลายหน่วย ทำให้การรวมจำนวนผิดโดยไม่มีใครเห็น',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by_field: ['product_name', 'product_code'],
      value: { op: 'count_distinct', field: 'uom' },
      sort: 'desc',
      top_n: 10,
      format: 'number',
      foot: 'ค่า 1 คือปกติ ตั้งแต่ 2 ขึ้นไปแปลว่าหน่วยนับปนกัน ควรแก้ที่ต้นทาง',
    },
  },
  {
    template_key: 'ita_missing_code',
    name: 'บรรทัดที่ไม่มีรหัสสินค้า',
    description: 'บรรทัดที่ไม่มีรหัส จะเชื่อมกับสูตรและยอดขายไม่ได้ ต้นทุนของมันจึงหายไปจากรายงานอื่น',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'half',
      row_filter: { op: 'blank', field: 'product_code' },
      empty_message: 'ทุกบรรทัดมีรหัสสินค้าครบ',
      columns: [
        { field: 'order_date', label: 'วันสั่ง' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'category_name', label: 'หมวด' },
        { field: 'total', label: 'มูลค่า', format: 'currency' },
      ],
      top_n: 200,
    },
  },
  {
    template_key: 'ita_code_convention',
    name: 'รหัสสินค้าที่ไม่เข้ารูปแบบ',
    description: 'รหัสที่ไม่ใช่รูปแบบ ABC-123 เช่น CH01 หรือ 116 — ตอนนี้ยัง join ได้เพราะมาจากทะเบียนเดียวกัน แต่จะพังเงียบเมื่อมีการคีย์มือหรือ import',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'half',
      row_filter: {
        op: 'and',
        rules: [
          { op: 'present', field: 'product_code' },
          { op: 'not', rule: { op: 'matches', field: 'product_code', pattern: '^[A-Za-z]{2,4}-[0-9]{2,4}$' } },
        ],
      },
      empty_message: 'รหัสสินค้าทุกตัวเข้ารูปแบบเดียวกัน',
      columns: [
        { field: 'product_code', label: 'รหัส' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'category_name', label: 'หมวด' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
      ],
      top_n: 200,
    },
  },
  {
    template_key: 'ita_order_frequency',
    name: 'สินค้าที่สั่งบ่อยที่สุด',
    description: 'นับจำนวนใบสั่งซื้อที่มีสินค้านั้น ของที่สั่งถี่ครั้งละน้อยคือจุดที่รวมรอบสั่งแล้วลดงานเอกสารได้',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by_field: ['product_name', 'product_code'],
      value: { op: 'count_distinct', field: 'po_number' },
      label_extra: { value: { op: 'avg', field: 'total' }, suffix: ' บาท/ครั้ง' },
      top_n: 12,
      format: 'number',
      foot: 'ในวงเล็บคือมูลค่าเฉลี่ยต่อบรรทัด',
    },
  },
  {
    template_key: 'ita_top_lines',
    name: 'บรรทัดที่มูลค่าสูงสุด',
    description: 'รายการซื้อรายบรรทัดเรียงตามมูลค่า ใช้สุ่มตรวจเอกสารจริง',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'full',
      columns: [
        { field: 'total', label: 'มูลค่า', format: 'currency' },
        { field: 'order_date', label: 'วันสั่ง' },
        { field: 'po_number', label: 'PO' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
        { field: 'branch', label: 'สาขา' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'qty', label: 'จำนวน', format: 'number' },
        { field: 'uom', label: 'หน่วย' },
        { field: 'price', label: 'ราคา/หน่วย', format: 'currency' },
      ],
      top_n: 50,
    },
  },
  {
    template_key: 'ita_split_orders',
    name: 'ใบสั่งที่ถูกแตกส่ง',
    description: 'บรรทัดที่มีสถานะแตกใบสั่ง ส่งหลายรอบหมายถึงงานรับของและงานเอกสารเพิ่มขึ้นทุกรอบ',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      row_filter: { op: 'present', field: 'split_order_status' },
      empty_message: 'ไม่มีใบสั่งที่ถูกแตกส่ง',
      group_by_field: ['supplier'],
      value: { op: 'count_distinct', field: 'po_number' },
      top_n: 10,
      format: 'number',
      foot: 'นับเป็นจำนวนใบสั่ง ไม่ใช่จำนวนบรรทัด',
    },
  },
  {
    template_key: 'ita_do_vs_grn',
    name: 'ของที่ส่งมากับของที่รับไม่ตรงกัน',
    description: 'เทียบจำนวนบนใบส่งของกับจำนวนที่รับเข้าจริง ส่วนต่างตรงนี้คือของเสียหายระหว่างทางหรือการนับผิดตอนรับ',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'full',
      derived: [{ field: 'qty_gap', expr: { op: 'sub', a: { field: 'grn_quantity' }, b: { field: 'do_quantity' } } }],
      row_filter: {
        op: 'and',
        rules: [
          { op: 'present', field: 'do_number' },
          { op: 'present', field: 'grn_number' },
          { op: 'differs', a: { field: 'grn_quantity' }, b: { field: 'do_quantity' }, tolerance: 0.001 },
        ],
      },
      empty_message: 'จำนวนบนใบส่งของตรงกับที่รับเข้าทุกบรรทัด',
      columns: [
        { field: 'do_date', label: 'วันส่ง' },
        { field: 'do_number', label: 'ใบส่งของ' },
        { field: 'grn_number', label: 'ใบรับของ' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'do_quantity', label: 'ส่งมา', format: 'number' },
        { field: 'grn_quantity', label: 'รับเข้า', format: 'number' },
        { field: 'qty_gap', label: 'ส่วนต่าง', format: 'number' },
      ],
      top_n: 200,
    },
  },

  // ---------- Supplier Quality ----------
  // "Delivered short" here means a CLOSED line — invoiced — whose invoiced
  // quantity is below the PO by more than the tolerance. An invoiced line is
  // final: what was billed is what the supplier stands behind, so an open line
  // that simply has not arrived yet never counts against anyone.
  //
  // Ranking uses the Wilson lower bound of the short-line rate, not the raw
  // rate, so a supplier with 1 short line out of 2 cannot outrank one with 30
  // out of 200. Quantities are compared within a line, so mixed units (kg on
  // one line, pieces on another) never get added together.
  ...supplierQualityTemplates(),

  // ---------- Price Change ----------
  // Built on the purchase-analysis pull the app already syncs, so none of it
  // costs FMH quota. A product is keyed by code AND unit: the same code bought
  // by the kg and by the case is two prices, never one.
  ...priceChangeTemplates(),

  // ---------- Actual vs Theoretical ----------
  // FMH computes the variance; KSS adds what it is made of. Joining recorded
  // wastage splits the gap into the part someone wrote down and the part
  // nobody can account for — over-portioning, loss, miscounts.
  ...avtTemplates(),

  // ---------- Cross-report (the dashboard does the join itself) ----------
  // FMH has no report that spans procurement and sales, so these compute the
  // answer here: bucket each report by a shared key, total what matters, line
  // the buckets up. KSS is the only party holding both halves.
  //
  // The headline is that there are TWO gross margins and they are not the same
  // number. FMH's COGS report values what was sold at RECIPE cost — what the
  // dishes should have cost. Purchase analysis holds what was actually paid to
  // suppliers. The gap between the two margins is waste, over-buying, stock
  // movement and price drift, and it is invisible inside either report alone.
  {
    template_key: 'ck_margin_kpi',
    name: 'CK gross margin — จริงเทียบกับตามสูตร',
    description: 'ยอดขาย CK เทียบยอดซื้อจริง และเทียบต้นทุนตามสูตร ส่วนต่างสองค่านี้คือของที่หายไประหว่างทาง',
    category: 'Cross-report',
    report_source: 'cogs-trend',
    chart_type: 'kpi',
    config: {
      size: 'full',
      sources: [
        { as: 'sales', source: 'cogs-trend' },
        { as: 'purchase', source: 'purchase-analysis' },
      ],
      pivot: {
        key_field: 'period',
        key: { sales: { field: 'period', bucket: 'month' }, purchase: { field: 'order_date', bucket: 'month' } },
        columns: [
          { field: 'sales_value', from: 'sales', metric: sum('sales') },
          { field: 'recipe_cost', from: 'sales', metric: sum('cogs') },
          { field: 'purchase_value', from: 'purchase', metric: sum('total') },
        ],
      },
      metrics: [
        { label: 'ยอดขาย CK', format: 'currency', value: sum('sales_value') },
        { label: 'ยอดซื้อจริง', format: 'currency', value: sum('purchase_value') },
        { label: 'ต้นทุนตามสูตร', format: 'currency', value: sum('recipe_cost') },
        { label: 'GM จ่ายจริง', format: 'pct', value: { op: 'ratio_pct', a: { op: 'diff', a: sum('sales_value'), b: sum('purchase_value') }, b: sum('sales_value') } },
        { label: 'GM ตามสูตร', format: 'pct', value: { op: 'ratio_pct', a: { op: 'diff', a: sum('sales_value'), b: sum('recipe_cost') }, b: sum('sales_value') } },
      ],
    },
  },
  {
    template_key: 'ck_margin_table',
    name: 'CK gross margin รายเดือน',
    description: 'แยกรายเดือน ยอดขาย ยอดซื้อ ต้นทุนตามสูตร และช่องว่างระหว่าง GM สองแบบ',
    category: 'Cross-report',
    report_source: 'cogs-trend',
    chart_type: 'table',
    config: {
      size: 'full',
      sources: [
        { as: 'sales', source: 'cogs-trend' },
        { as: 'purchase', source: 'purchase-analysis' },
      ],
      pivot: {
        key_field: 'period',
        key: { sales: { field: 'period', bucket: 'month' }, purchase: { field: 'order_date', bucket: 'month' } },
        columns: [
          { field: 'sales_value', from: 'sales', metric: sum('sales') },
          { field: 'recipe_cost', from: 'sales', metric: sum('cogs') },
          { field: 'purchase_value', from: 'purchase', metric: sum('total') },
        ],
      },
      derived: [
        { field: 'gm_cash', expr: { op: 'sub', a: { field: 'sales_value' }, b: { field: 'purchase_value' } } },
        { field: 'gm_cash_pct', expr: { op: 'pct_of', a: { op: 'sub', a: { field: 'sales_value' }, b: { field: 'purchase_value' } }, b: { field: 'sales_value' } } },
        { field: 'gm_recipe_pct', expr: { op: 'pct_of', a: { op: 'sub', a: { field: 'sales_value' }, b: { field: 'recipe_cost' } }, b: { field: 'sales_value' } } },
        { field: 'gap_pct', expr: { op: 'sub', a: { op: 'pct_of', a: { op: 'sub', a: { field: 'sales_value' }, b: { field: 'recipe_cost' } }, b: { field: 'sales_value' } }, b: { op: 'pct_of', a: { op: 'sub', a: { field: 'sales_value' }, b: { field: 'purchase_value' } }, b: { field: 'sales_value' } } } },
      ],
      columns: [
        { field: 'period', label: 'เดือน' },
        { field: 'sales_value', label: 'ยอดขาย', format: 'currency' },
        { field: 'purchase_value', label: 'ยอดซื้อจริง', format: 'currency' },
        { field: 'recipe_cost', label: 'ต้นทุนตามสูตร', format: 'currency' },
        { field: 'gm_cash', label: 'GM จ่ายจริง', format: 'currency' },
        { field: 'gm_cash_pct', label: 'GM จ่ายจริง %', format: 'pct' },
        { field: 'gm_recipe_pct', label: 'GM ตามสูตร %', format: 'pct' },
        { field: 'gap_pct', label: 'ช่องว่าง', format: 'pct' },
        { field: 'purchase_rows', label: 'บรรทัดซื้อ', format: 'number' },
      ],
      top_n: 24,
      foot: 'เดือนเดียวอ่านแล้วแกว่ง เพราะของที่ซื้อเดือนนี้อาจขายเดือนหน้า ดูแนวโน้มสามเดือนขึ้นไปจะตรงกว่า',
    },
  },
  {
    template_key: 'ck_margin_trend',
    name: 'ช่องว่าง GM จริงกับ GM ตามสูตร',
    description: 'สองเส้นที่ควรวิ่งใกล้กัน ถ้าถ่างออกเรื่อย ๆ แปลว่าของหายระหว่างทางมากขึ้น',
    category: 'Cross-report',
    report_source: 'cogs-trend',
    chart_type: 'line',
    config: {
      size: 'full',
      sources: [
        { as: 'sales', source: 'cogs-trend' },
        { as: 'purchase', source: 'purchase-analysis' },
      ],
      pivot: {
        key_field: 'period',
        key: { sales: { field: 'period', bucket: 'month' }, purchase: { field: 'order_date', bucket: 'month' } },
        columns: [
          { field: 'sales_value', from: 'sales', metric: sum('sales') },
          { field: 'recipe_cost', from: 'sales', metric: sum('cogs') },
          { field: 'purchase_value', from: 'purchase', metric: sum('total') },
        ],
      },
      date_fields: ['period'],
      bucket: 'month',
      series: [
        { label: 'GM ตามสูตร %', color: '#2F6FB0', value: { op: 'ratio_pct', a: { op: 'diff', a: sum('sales_value'), b: sum('recipe_cost') }, b: sum('sales_value') } },
        { label: 'GM จ่ายจริง %', color: '#BE4229', value: { op: 'ratio_pct', a: { op: 'diff', a: sum('sales_value'), b: sum('purchase_value') }, b: sum('sales_value') } },
      ],
      format: 'pct',
      foot: 'เส้นจ่ายจริงจะแกว่งกว่าเสมอ เพราะรอบซื้อกับรอบขายไม่ตรงกัน ดูระยะห่างเฉลี่ย อย่าดูเดือนเดียว',
    },
  },
  {
    template_key: 'ck_sales_vs_purchase',
    name: 'ยอดขาย CK เทียบยอดซื้อ รายเดือน',
    description: 'แท่งคู่ต่อเดือน ยอดขายของครัวกลางวางข้างยอดที่จ่ายซื้อของจริง เห็นทันทีว่าเดือนไหนซื้อเกินสัดส่วนที่ขายได้',
    category: 'Cross-report',
    report_source: 'cogs-trend',
    chart_type: 'line',
    config: {
      size: 'full',
      sources: [
        { as: 'sales', source: 'cogs-trend' },
        { as: 'purchase', source: 'purchase-analysis' },
      ],
      pivot: {
        key_field: 'period',
        key: { sales: { field: 'period', bucket: 'month' }, purchase: { field: 'order_date', bucket: 'month' } },
        columns: [
          { field: 'sales_value', from: 'sales', metric: sum('sales') },
          { field: 'purchase_value', from: 'purchase', metric: sum('total') },
        ],
      },
      date_fields: ['period'],
      bucket: 'month',
      mark: 'bar',
      series: [
        { label: 'ยอดขาย CK', color: '#2F6FB0', value: sum('sales_value') },
        { label: 'ยอดซื้อจริง', color: '#BE4229', value: sum('purchase_value') },
      ],
      format: 'currency',
      foot: 'เดือนที่แท่งซื้อสูงเกือบเท่าแท่งขาย มักเป็นเดือนที่ตุนของ ดูเดือนถัดไปด้วยก่อนสรุปว่าซื้อเกิน',
    },
  },
  {
    template_key: 'ck_category_mix',
    name: 'ภาพรวมขายและซื้อของครัวกลาง',
    description: 'สี่ช่องในหน้าเดียว ยอดขายตามกลุ่มสินค้า ยอดขายรายสัปดาห์ ยอดซื้อตามกลุ่มสินค้า และยอด PO รายสัปดาห์ที่แยกส่วนรับของแล้วแต่ยังไม่มีใบแจ้งหนี้',
    category: 'Cross-report',
    report_source: 'purchase-analysis',
    chart_type: 'panels',
    config: (() => {
      // A line is awaiting invoice once goods are received (GRN) and no
      // invoice has been matched to it yet.
      const awaiting = {
        op: 'sum_where',
        field: 'grn_total',
        where: { op: 'and', rules: [{ op: 'present', field: 'grn_number' }, { op: 'blank', field: 'invoice_number' }] },
      };
      return {
        size: 'full',
        sources: [
          // Server-side grouping: one row per category instead of every menu line.
          { as: 'sales_cat', source: 'cogs', group_by: 'category' },
          { as: 'sales_time', source: 'cogs-trend' },
          { as: 'purchase', source: 'purchase-analysis' },
        ],
        // Read left to right as two rows: sales, then purchases — each a mix
        // and a timeline.
        panels: [
          {
            title: 'ยอดขาย CK ตามกลุ่มสินค้า',
            note: 'ทั้งช่วงที่ซิงก์ล่าสุด (80 วัน) รายงานแยกหมวดนี้ไม่มีวันที่ให้กรอง',
            from: 'sales_cat',
            chart: 'donut',
            group_by_field: ['category_name', 'category', 'name'],
            value: sum('total_sales'),
            format: 'currency',
            top_n: 7,
            headline: [{ label: 'ยอดขาย', value: sum('total_sales'), color: '#2F6FB0' }],
          },
          {
            title: 'ยอดขาย CK รายสัปดาห์',
            from: 'sales_time',
            chart: 'line',
            mark: 'bar',
            date_fields: ['period'],
            bucket: 'wom',
            format: 'currency',
            series: [{ label: 'ยอดขาย', color: '#2F6FB0', value: sum('sales') }],
            legend: false, // one series, already named in the headline
            headline: [
              { label: 'ยอดขาย', value: sum('sales'), color: '#2F6FB0' },
              { label: 'ต้นทุนตามสูตร', value: sum('cogs') },
            ],
          },
          {
            title: 'ยอดซื้อตามกลุ่มสินค้า',
            from: 'purchase',
            chart: 'donut',
            group_by_field: ['category_name'],
            value: sum('total'),
            format: 'currency',
            top_n: 7,
            headline: [{ label: 'ยอดซื้อ', value: sum('total'), color: '#A9812F' }],
          },
          {
            title: 'ยอด PO รายสัปดาห์ และส่วนที่ค้างรอใบแจ้งหนี้',
            note: 'ความสูงแท่ง = ยอด PO · สีแดง = รับของแล้ว (มี GRN) แต่ยังไม่มี INV',
            from: 'purchase',
            chart: 'line',
            mark: 'bar',
            stacked: true,
            date_fields: ['order_date'],
            bucket: 'wom',
            format: 'currency',
            series: [
              { label: 'รับของแล้ว รอ INV', color: '#BE4229', value: awaiting },
              { label: 'ส่วนอื่นของ PO', color: '#D6CFBC', value: { op: 'floor0', a: { op: 'diff', a: sum('po_total'), b: awaiting } } },
            ],
            headline: [
              { label: 'รอ INV', value: awaiting, color: '#BE4229' },
              { label: 'PO รวม', value: sum('po_total') },
            ],
          },
        ],
      };
    })(),
  },
  {
    template_key: 'bought_not_in_recipe',
    name: 'ของที่ซื้อแต่ไม่อยู่ในสูตรไหนเลย',
    description: 'วัตถุดิบที่จ่ายเงินซื้อจริง แต่ไม่ปรากฏในสูตรใด ต้นทุนของมันจึงไม่เคยถูกคิดเข้าเมนู',
    category: 'Cross-report',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'full',
      sources: [
        { as: 'purchase', source: 'purchase-analysis' },
        { as: 'recipe', source: 'menu-costing' },
      ],
      pivot: {
        key_field: 'product_code',
        key: { purchase: 'product_code', recipe: 'ingredient_code' },
        columns: [
          { field: 'product_name', from: 'purchase', first: 'product_name' },
          { field: 'category_name', from: 'purchase', first: 'category_name' },
          { field: 'supplier', from: 'purchase', first: 'supplier' },
          { field: 'spend', from: 'purchase', metric: sum('total') },
        ],
      },
      // Bought at least once, and in no recipe line at all.
      row_filter: {
        op: 'and',
        rules: [
          { op: 'gt', a: { field: 'purchase_rows' }, b: 0 },
          { op: 'lte', a: { field: 'recipe_rows' }, b: 0 },
        ],
      },
      empty_message: 'ของที่ซื้อทุกตัวอยู่ในสูตรแล้ว',
      columns: [
        { field: 'product_code', label: 'รหัส' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'category_name', label: 'หมวด' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
        { field: 'spend', label: 'ยอดซื้อ', format: 'currency' },
        { field: 'purchase_rows', label: 'ครั้งที่ซื้อ', format: 'number' },
      ],
      top_n: 200,
      foot: 'ของขายต่อ เช่น น้ำอัดลมกระป๋อง จะโผล่ที่นี่โดยไม่ผิด ที่ต้องดูคือวัตถุดิบจริงที่ตกสำรวจ',
    },
  },
];

// How the four fixed tabs of the old single-tenant app map onto catalog
// templates — used once, by db/migrate.js, to convert the legacy dashboards
// into widget-based dashboards that look like they did before.
const LEGACY_DASHBOARD_WIDGETS = {
  purchase_analysis: ['pa_kpis', 'pa_trend', 'pa_attention_products', 'pa_top_suppliers', 'pa_category_variance'],
  cogs: ['cogs_table'],
  menu_costing: ['mc_kpis', 'mc_top_ingredients', ['mc_sensitivity', { size: 'full' }], 'mc_menu_breakdown'],
  sales_by_branch: ['sb_table'],
};

async function syncCatalog(conn = pool) {
  for (const t of BUILTIN_TEMPLATES) {
    await conn.query(
      `INSERT INTO widget_templates
         (template_key, name, description, category, report_source, chart_type, default_config_json, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = IF(customized, name, VALUES(name)),
         description = IF(customized, description, VALUES(description)),
         category = IF(customized, category, VALUES(category)),
         report_source = IF(customized, report_source, VALUES(report_source)),
         chart_type = IF(customized, chart_type, VALUES(chart_type)),
         default_config_json = IF(customized, default_config_json, VALUES(default_config_json)),
         sort_order = VALUES(sort_order)`,
      [
        t.template_key,
        t.name,
        t.description,
        t.category,
        t.report_source,
        t.chart_type,
        JSON.stringify(t.config),
        BUILTIN_TEMPLATES.indexOf(t) + 1,
      ]
    );
  }
}

// Adds templates, in order, to a dashboard (skips unknown keys). Each entry is
// a template key, or [key, configOverrides] to place it with overrides.
async function addTemplatesToDashboard(conn, dashboardId, entries) {
  for (let i = 0; i < entries.length; i++) {
    const [key, overrides] = Array.isArray(entries[i]) ? entries[i] : [entries[i], null];
    const [[tpl]] = await conn.query(`SELECT id FROM widget_templates WHERE template_key = ?`, [key]);
    if (!tpl) continue;
    await conn.query(
      `INSERT INTO dashboard_widgets (dashboard_id, widget_template_id, position, config_json) VALUES (?, ?, ?, ?)`,
      [dashboardId, tpl.id, i + 1, overrides ? JSON.stringify(overrides) : null]
    );
  }
}

function parseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

// A dashboard's widgets, each with its template's default config merged
// under the instance's overrides.
async function listWidgets(dashboardId) {
  const [rows] = await pool.query(
    `SELECT w.id, w.title, w.position, w.config_json,
            t.id AS template_id, t.template_key, t.name AS template_name,
            t.report_source, t.chart_type, t.default_config_json
     FROM dashboard_widgets w
     JOIN widget_templates t ON t.id = w.widget_template_id
     WHERE w.dashboard_id = ?
     ORDER BY w.position, w.id`,
    [dashboardId]
  );
  return rows.map((r) => {
    const defaults = parseJson(r.default_config_json, {});
    const overrides = parseJson(r.config_json, {});
    return {
      id: r.id,
      title: r.title || r.template_name,
      custom_title: r.title,
      position: r.position,
      template_id: r.template_id,
      template_key: r.template_key,
      template_name: r.template_name,
      report_source: r.report_source,
      chart_type: r.chart_type,
      config: { ...defaults, ...overrides },
      config_overrides: overrides,
    };
  });
}

module.exports = {
  BUILTIN_TEMPLATES,
  CHART_TYPES,
  LEGACY_DASHBOARD_WIDGETS,
  syncCatalog,
  addTemplatesToDashboard,
  listWidgets,
};
