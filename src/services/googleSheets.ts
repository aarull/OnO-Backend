import { google, sheets_v4 } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const APPEND_RANGE = 'Sheet1!A:O';

let sheetsClientPromise: Promise<sheets_v4.Sheets> | null = null;

function formatDateDDMMYY(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}-${mm}-${yy}`;
}

function formatMonthMMMYY(d: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}

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

  const now = new Date();

  const invoiceNumber = String(invoice.invoice_number ?? invoice.id ?? '');
  const gstin =
    invoice.gst_number != null && String(invoice.gst_number).trim() !== ''
      ? String(invoice.gst_number)
      : 'NA';
  const payeeName =
    invoice.account_holder_name != null ? String(invoice.account_holder_name) : '';

  const baseAmount = num(invoice.amount);
  const tdsAmount = num(invoice.tds_amount);
  const afterTds = baseAmount - tdsAmount;
  const gstOn = invoice.gst === true;
  const gstAmount = gstOn ? baseAmount * 0.18 : 0;
  const netAmt = num(invoice.final_payable_amount);
  const invoiceAmt = baseAmount + gstAmount;
  const totalToProcess = num(invoice.final_payable_amount);

  const row: (string | number)[] = [
    formatDateDDMMYY(now),
    formatMonthMMMYY(now),
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
    '',
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
