import puppeteer from 'puppeteer';
import path from 'node:path';
import { supabaseAdmin } from '../lib/supabase.js';

const INVOICE_BUCKET = 'invoices';

function inr(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  const safe = Number.isFinite(n) ? n : 0;
  return safe.toLocaleString('en-IN');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateDDMMYY(d: Date): string {
  return d
    .toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    })
    .replace(/\//g, '-');
}

function buildInvoiceHtml(invoice: Record<string, unknown>): string {
  const invoiceId = String(invoice.invoice_number ?? invoice.id ?? '');
  const invoiceDate = formatDateDDMMYY(new Date());

  const creatorName = escapeHtml(String(invoice.creator_name ?? ''));
  const creatorPan = escapeHtml(String(invoice.pan_number ?? ''));
  const creatorGst = escapeHtml(String(invoice.gst_number ?? ''));

  const campaignName = escapeHtml(String(invoice.campaign ?? ''));

  const baseAmount = typeof invoice.amount === 'number' ? invoice.amount : Number(invoice.amount);
  const base = Number.isFinite(baseAmount) ? baseAmount : 0;

  const gstOn = invoice.gst === true;
  const gstAmount = gstOn ? base * 0.18 : 0;

  const netAdjusted = base + gstAmount;

  const accountHolder = escapeHtml(String(invoice.account_holder_name ?? ''));
  const accountNumber = escapeHtml(String(invoice.account_no ?? ''));
  const ifscCode = escapeHtml(String(invoice.ifsc ?? ''));

  // Important: no creator phone/email in template.
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
        
        body {
            font-family: 'Inter', Helvetica, Arial, sans-serif;
            color: #000000;
            background-color: #ffffff;
            margin: 0;
            padding: 40px 50px;
            box-sizing: border-box;
        }
        .header-row {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 50px;
        }
        .title {
            font-size: 72px;
            font-weight: 800;
            letter-spacing: -0.04em;
            margin: 0;
            line-height: 1;
        }
        .meta {
            text-align: right;
            font-size: 14px;
            line-height: 1.6;
            margin-top: 10px;
        }
        .parties-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 60px;
            font-size: 14px;
            line-height: 1.6;
        }
        .party-col {
            width: 48%;
        }
        .party-title {
            font-weight: 600;
            margin-bottom: 8px;
            text-transform: uppercase;
            font-size: 12px;
            color: #555;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 40px;
        }
        th {
            text-align: left;
            border-bottom: 2px solid #000;
            padding-bottom: 12px;
            font-weight: 600;
            font-size: 14px;
        }
        td {
            padding: 16px 0;
            border-bottom: 1px solid #eaeaea;
            font-size: 14px;
        }
        .amount-col {
            text-align: right;
        }
        .totals-container {
            width: 50%;
            margin-left: auto;
            font-size: 14px;
        }
        .total-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
        }
        .total-row.net {
            font-weight: 600;
            font-size: 16px;
            border-top: 2px solid #000;
            padding-top: 12px;
            margin-top: 4px;
        }
        .payment-info {
            margin-top: 60px;
            padding-top: 20px;
            border-top: 1px solid #000;
            font-size: 14px;
            line-height: 1.6;
        }
    </style>
</head>
<body>

    <div class="header-row">
        <h1 class="title">Invoice</h1>
        <div class="meta">
            <div><strong>${invoiceDate}</strong></div>
            <div>Invoice No. ${escapeHtml(invoiceId)}</div>
        </div>
    </div>

    <div class="parties-row">
        <div class="party-col">
            <div class="party-title">From:</div>
            <div><strong>${creatorName}</strong></div>
            <div>PAN: ${creatorPan}</div>
            <div>GSTIN: ${creatorGst}</div>
        </div>
        <div class="party-col">
            <div class="party-title">Billed To:</div>
            <div><strong>TOCM GLOBAL PRIVATE LIMITED</strong></div>
            <div>CIN: U73100UP2025PTC216240</div>
            <div>H-120, Second Floor, Sector 63,</div>
            <div>Noida, Gautambuddha Nagar,</div>
            <div>Uttar Pradesh 201301, India</div>
            <div>GSTIN: 09AALCT5725D1Z6</div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th>Description</th>
                <th class="amount-col">Amount</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td>${campaignName}</td>
                <td class="amount-col">₹${inr(base)}</td>
            </tr>
        </tbody>
    </table>

    <div class="totals-container">
        <div class="total-row">
            <span>Base Amount</span>
            <span>₹${inr(base)}</span>
        </div>
        <div class="total-row">
            <span>GST (18%)</span>
            <span>+₹${inr(gstAmount)}</span>
        </div>
        <div class="total-row net">
            <span>Net Payable</span>
            <span>₹${inr(netAdjusted)}</span>
        </div>
    </div>

    <div class="payment-info">
        <div class="party-title">Payment Information</div>
        <div><strong>Account Name:</strong> ${accountHolder}</div>
        <div><strong>Account No:</strong> ${accountNumber}</div>
        <div><strong>IFSC:</strong> ${ifscCode}</div>
    </div>

</body>
</html>`;
}

export async function generateUploadAndPersistInvoicePdf(
  invoice: Record<string, unknown>,
): Promise<{ invoice_file_url: string; storage_path: string }> {
  const invoiceUuid = String(invoice.id ?? '');
  const invoiceNumber = String(invoice.invoice_number ?? invoice.id ?? '');
  const creatorId = String(invoice.creator_id ?? 'unknown');

  console.log('PDF Generation Started for:', invoiceUuid);
  console.log('[invoicePdf] starting PDF generation', {
    id: invoiceUuid,
    invoice_number: invoiceNumber,
    creator_id: creatorId,
  });

  const html = buildInvoiceHtml(invoice);

  const browser = await puppeteer.launch({
    executablePath: path.join(
      process.cwd(),
      '.puppeteer-cache/chrome/linux-147.0.7727.57/chrome-linux64/chrome',
    ),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
    });
    console.log('[invoicePdf] PDF generated', { bytes: pdfBuffer.length, id: invoiceUuid });

    const fileName = invoiceNumber || invoiceUuid || 'invoice';
    const storagePath = `${creatorId}/${fileName}.pdf`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from(INVOICE_BUCKET)
      .upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      throw new Error(uploadError.message);
    }
    console.log('[invoicePdf] PDF uploaded to storage', { storagePath, id: invoiceUuid });

    const { data: publicData } = supabaseAdmin.storage
      .from(INVOICE_BUCKET)
      .getPublicUrl(storagePath);

    const publicUrl = publicData?.publicUrl;
    if (!publicUrl) {
      throw new Error('Failed to generate public URL for PDF');
    }

    // Update by UUID id (primary key); fallback to invoice_number for legacy calls.
    const { error: updateError, data: updated } = await supabaseAdmin
      .from('invoices')
      .update({ invoice_file_url: publicUrl })
      .eq('id', invoiceUuid)
      .select('id')
      .maybeSingle();
    if (updateError) throw new Error(updateError.message);
    console.log('[invoicePdf] DB updated invoice_file_url', {
      id: invoiceUuid,
      matched_by: updated ? 'id' : 'none',
    });

    if (!updated && invoiceNumber) {
      const { error: fallbackError } = await supabaseAdmin
        .from('invoices')
        .update({ invoice_file_url: publicUrl })
        .eq('invoice_number', invoiceNumber);
      if (fallbackError) throw new Error(fallbackError.message);
      console.log('[invoicePdf] DB updated invoice_file_url (fallback)', {
        invoice_number: invoiceNumber,
      });
    }

    return { invoice_file_url: publicUrl, storage_path: storagePath };
  } catch (err) {
    console.error('[invoicePdf] PDF generation failed (full error object):', err);
    throw err;
  } finally {
    await browser.close();
  }
}

