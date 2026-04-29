import { google, sheets_v4 } from 'googleapis';
import { formatIstToDDMMYY, formatIstToMonthYear, getNow } from '../utils/dateUtils.js';

export type ReleaseSheetRowParams = {
  invoiceNumber: string;
  /** Column P: remaining net amount after this payment (final_payable - cumulative paid after txn). */
  remainingNet: number;
  /** Column Q: amount paid in this transaction. */
  paidNow: number;
  /** Column R: UTR reference. */
  utr: string;
  /** Column S: payment date (already formatted, IST). */
  paymentDateIst: string;
};

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
function appendRangeAtoO(): string {
  return `${sheetTabName()}!A:O`;
}

function sheetTabName(): string {
  return process.env.GOOGLE_SHEET_TAB ?? 'Sheet1';
}

let sheetsClientPromise: Promise<sheets_v4.Sheets> | null = null;

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  if (sheetsClientPromise) return sheetsClientPromise;

  sheetsClientPromise = (async () => {
    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
    const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;
    if (!clientEmail || !privateKeyRaw) {
      throw new Error('Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY');
    }
    const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

    const auth = new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes: SCOPES,
    });

    return google.sheets({ version: 'v4', auth });
  })();

  return sheetsClientPromise;
}

/**
 * Appends one invoice row to Google Sheets (columns A–O, starting at A).
 * Row has no leading padding; targets Sheet1!A:O.
 */
export async function appendInvoiceToSheet(invoice: Record<string, unknown>): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    console.error('[googleSheets] GOOGLE_SHEET_ID is not set; skipping append');
    return;
  }

  const createdAtRaw = invoice.created_at ?? (invoice as any).createdAt ?? (invoice as any).date;
  const createdAt = createdAtRaw != null ? new Date(String(createdAtRaw)) : getNow();
  const creationInstant = Number.isFinite(createdAt.getTime()) ? createdAt : getNow();

  const invoiceNumber = String(invoice.invoice_number ?? invoice.id ?? '');
  const gstin =
    invoice.gst_number != null && String(invoice.gst_number).trim() !== ''
      ? String(invoice.gst_number)
      : 'NA';
  const payeeName =
    invoice.account_holder_name != null ? String(invoice.account_holder_name) : '';
  const imRemark = invoice.im_remark != null ? String(invoice.im_remark) : '';

  const baseAmount = num(invoice.amount);
  const tdsPercentageRaw = (invoice as any).tds_percentage ?? (invoice as any).tdsPercentage;
  const tdsPercentage =
    typeof tdsPercentageRaw === 'number'
      ? tdsPercentageRaw
      : typeof tdsPercentageRaw === 'string'
        ? Number(tdsPercentageRaw)
        : 0;
  const safeTdsPercentage = Number.isFinite(tdsPercentage) ? tdsPercentage : 0;
  const tdsAmount = baseAmount * (safeTdsPercentage / 100);
  const afterTds = baseAmount - tdsAmount;
  const gstOn = invoice.gst === true;
  const gstAmount = gstOn ? baseAmount * 0.18 : 0;
  const netAmt = num(invoice.final_payable_amount);
  const invoiceAmt = baseAmount + gstAmount;
  const totalToProcess = num(invoice.final_payable_amount);

  const row: (string | number)[] = [
    formatIstToDDMMYY(creationInstant),
    formatIstToMonthYear(creationInstant),
    invoiceNumber,
    gstin,
    payeeName,
    'Creator',
    baseAmount,
    afterTds,
    gstAmount,
    netAmt,
    invoiceAmt,
    '',
    imRemark,
    '',
    totalToProcess,
  ];

  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: appendRangeAtoO(),
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [row],
    },
  });
}

/**
 * Finds the row where column C matches invoice_number and writes P–S (release payment).
 * P: remaining net after this payment, Q: paid now, R: UTR, S: payment date (IST string).
 */
export async function updateReleasePaymentColumnsInSheet(
  params: ReleaseSheetRowParams,
): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    console.error('[googleSheets] GOOGLE_SHEET_ID is not set; skipping release columns update');
    return;
  }

  const tab = sheetTabName();
  const sheets = await getSheetsClient();

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!C:C`,
  });

  const rows = data.values ?? [];
  const target = params.invoiceNumber.trim();
  let rowNumber = -1;

  for (let i = 0; i < rows.length; i++) {
    const cell = rows[i]?.[0];
    if (cell != null && String(cell).trim() === target) {
      rowNumber = i + 1;
      break;
    }
  }

  if (rowNumber < 1) {
    throw new Error(`[googleSheets] No sheet row found for invoice_number ${target}`);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!P${rowNumber}:S${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [
        [
          params.remainingNet,
          params.paidNow,
          params.utr,
          params.paymentDateIst,
        ],
      ],
    },
  });
}
