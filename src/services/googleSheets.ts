import { google, sheets_v4 } from 'googleapis';
import { formatIstToDDMMYY, formatIstToMonthYear, getNow } from '../utils/dateUtils.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const APPEND_RANGE = 'Sheet1!A:O';

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
    range: APPEND_RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [row],
    },
  });
}
