import { parse } from 'node-html-parser'
import type { ParsedReceipt, VerifyUnavailable } from './types'
import { parseReceiptAmount, parseReceiptDate } from './matching'

interface RawFields {
  receiverName?: string
  receiverNumber?: string
  payerName?: string
  payerNumber?: string
  status?: string
  receiptNumber?: string
  date?: string
  settled?: string
  total?: string
}

/** Normalize a label: lowercase, strip everything non-[a-z0-9]. This also drops the
 *  Amharic half of the receipt's bilingual "የከፋይ ስም/Payer Name" labels, leaving the
 *  English text to match against. */
function normLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Labels that appear as [label][value] rows: payer/credited party, status, totals.
 * The invoice-details columns (Invoice No / Payment date / Settled Amount) are NOT
 * here — real telebirr receipts lay those out as a COLUMNAR table (a header row of
 * labels followed by a separate data row), handled in its own pass below.
 */
const PAIR_LABELS: Record<string, keyof RawFields> = {}
const alias = (field: keyof RawFields, ...labels: string[]) => {
  for (const l of labels) PAIR_LABELS[normLabel(l)] = field
}
alias('receiverName', 'Credited Party name', 'Receiver Name', 'To')
alias(
  'receiverNumber',
  'Credited party account no',
  'Credited Party account number',
  'Receiver telebirr no',
)
alias('payerName', 'Payer Name', 'Debit Party Name', 'From')
alias('payerNumber', 'Payer telebirr no', 'Debit party account number')
alias('status', 'transaction status', 'Status')
alias('total', 'Total Paid Amount', 'Total amount paid', 'Total Paid', 'Total amount')

/** Columnar "Invoice details" header cells → which value column they mark. */
const COL_RECEIPT = new Set(['invoiceno', 'transactionnumber', 'receiptno', 'receiptnumber'])
const COL_DATE = new Set(['paymentdate', 'transactiontime', 'transactiondate'])
const COL_SETTLED = new Set(['settledamount'])

function cellText(c: { text: string }): string {
  return c.text.replace(/\s+/g, ' ').trim()
}

/** A row's DIRECT-child cells only. The receipt nests tables, and querySelectorAll
 *  would otherwise return an outer <tr>'s descendant cells flattened together. */
function directCells(row: ReturnType<typeof parse>) {
  return row.querySelectorAll('td, th').filter((c) => c.parentNode === row)
}

export function parseReceiptHtml(html: string): ParsedReceipt | VerifyUnavailable {
  if (/this request is not correct/i.test(html)) {
    return { unavailable: 'NOT_FOUND' }
  }

  let root
  try {
    root = parse(html)
  } catch {
    return { unavailable: 'PARSE_FAILED' }
  }

  const rows = root.querySelectorAll('tr')
  const fields: RawFields = {}

  // Pass 1 — columnar "Invoice details": find the header row that holds Invoice No
  // + Settled Amount (+ Payment date), then read the next row's cells positionally.
  // Keep scanning past false matches (e.g. a wrapper row) until the row below is a
  // real data row whose settled column parses as an amount.
  for (let r = 0; r < rows.length; r++) {
    const header = directCells(rows[r])
    let ri = -1
    let di = -1
    let si = -1
    header.forEach((c, ci) => {
      const l = normLabel(c.text)
      if (ri === -1 && COL_RECEIPT.has(l)) ri = ci
      if (di === -1 && COL_DATE.has(l)) di = ci
      if (si === -1 && COL_SETTLED.has(l)) si = ci
    })
    if (ri === -1 || si === -1) continue
    const next = rows[r + 1]
    if (!next) continue
    const data = directCells(next)
    if (data.length <= Math.max(ri, si, di)) continue
    const settledText = cellText(data[si])
    if (parseReceiptAmount(settledText) === null) continue
    fields.receiptNumber ??= cellText(data[ri])
    fields.settled ??= settledText
    if (di !== -1) fields.date ??= cellText(data[di])
    break
  }

  // Pass 2 — label→value rows. For each row, a cell whose text is a known label
  // takes the first following non-empty cell as its value. Handles both [label,
  // value] and [spacer, label, value] layouts (the fee/total rows put the label in
  // the middle cell). First match per field wins.
  for (const row of rows) {
    const cells = directCells(row)
    if (cells.length < 2) continue
    for (let i = 0; i < cells.length - 1; i++) {
      const key = PAIR_LABELS[normLabel(cells[i].text)]
      if (!key || fields[key] !== undefined) continue
      for (let j = i + 1; j < cells.length; j++) {
        const v = cellText(cells[j])
        if (v) {
          fields[key] = v
          break
        }
      }
    }
  }

  const settledAmount = fields.settled ? parseReceiptAmount(fields.settled) : null
  const required =
    fields.receiverName &&
    fields.receiverNumber &&
    fields.status &&
    fields.receiptNumber &&
    settledAmount !== null
  if (!required) {
    return { unavailable: 'PARSE_FAILED' }
  }

  return {
    receiverName: fields.receiverName!.trim(),
    receiverNumberMasked: fields.receiverNumber!.trim(),
    settledAmount: settledAmount!,
    totalPaid: fields.total ? parseReceiptAmount(fields.total) : null,
    status: fields.status!.trim(),
    receiptNumber: fields.receiptNumber!.trim(),
    receiptTime: fields.date ? parseReceiptDate(fields.date) : null,
    payerName: fields.payerName?.trim() ?? null,
    payerNumberMasked: fields.payerNumber?.trim() ?? null,
  }
}
