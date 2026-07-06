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

function normLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** English label aliases (normalized: lowercase, alphanumerics only) → field. */
const LABELS: Record<string, keyof RawFields> = {}
const alias = (field: keyof RawFields, ...labels: string[]) => {
  for (const l of labels) LABELS[normLabel(l)] = field
}

alias('receiverName', 'Credited Party name', 'Credited Party Name', 'Receiver Name', 'To')
alias(
  'receiverNumber',
  'Credited party account no',
  'Credited Party account number',
  'Receiver telebirr no',
  'Receiver account',
)
alias('payerName', 'Payer Name', 'Debit Party Name', 'From')
alias('payerNumber', 'Payer telebirr no', 'Debit party account number')
alias('status', 'transaction status', 'Status')
alias('receiptNumber', 'transaction number', 'Receipt No', 'Receipt Number', 'Invoice No')
alias('date', 'Payment Date', 'transaction time', 'Transaction Date', 'Date')
alias('settled', 'settled amount', 'Settled Amount')
alias('total', 'Total amount paid', 'Total Paid', 'Total amount')

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

  // Collect label→value pairs from every 2+ cell table row.
  const fields: RawFields = {}
  for (const row of root.querySelectorAll('tr')) {
    const cells = row.querySelectorAll('td, th')
    if (cells.length < 2) continue
    const label = normLabel(cells[0].text.trim())
    const value = cells[1].text.replace(/\s+/g, ' ').trim()
    const key = LABELS[label]
    if (key && value && fields[key] === undefined) fields[key] = value
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
