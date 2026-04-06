// utils/pdfService.js
const PDFDocument = require('pdfkit');
const axios = require('axios');

/**
 * generateQuotePDFBuffer(quoteData) -> Buffer
 * No filesystem writes. Safe for serverless.
 *
 * quoteData.catalogDisclaimer: ISO date string (e.g. "2026-01-15") if any
 *   line items were priced from the supplier catalog. Triggers a footer note.
 */
async function generateQuotePDFBuffer(quoteData) {
  const {
    jobName,
    items = [],
    subtotal = 0,
    tax = 0,
    total = 0,
    customerName,
    contractorName,
    companyName,
    companyAddress,
    companyPhone,
    logoUrl,
    catalogDisclaimer = null,
  } = quoteData || {};

  const doc = new PDFDocument({ size: 'A4', margin: 50 });

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));

  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Header
  if (logoUrl) {
    try {
      const logoResponse = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 8000 });
      doc.image(Buffer.from(logoResponse.data), 50, 50, { width: 100 });
    } catch {
      // fail-open: ignore logo failures
    }
  }

  doc
    .fontSize(12)
    .text(companyName || contractorName || 'Quote', 160, 50, { align: 'left' })
    .text(companyAddress || '', 160, 70)
    .text(companyPhone || '', 160, 90)
    .moveDown(2);

  doc.fontSize(20).text(`Quote for ${jobName || 'Job'}`, { align: 'center' }).moveDown();
  if (customerName) doc.fontSize(12).text(`Customer: ${customerName}`, { align: 'left' }).moveDown();

  // Table header
  doc.fontSize(10);
  const tableTop = doc.y;
  doc.text('Item', 50, tableTop)
    .text('Quantity', 250, tableTop)
    .text('Unit Price', 340, tableTop)
    .text('Total', 450, tableTop);
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

  let y = tableTop + 25;

  // Track whether any line came from catalog (for asterisk)
  let anyCatalog = false;

  for (const row of items) {
    const item = String(row?.item || '').trim();
    const quantity = Number(row?.quantity || 0);
    const price = Number(row?.price || 0);
    const lineTotal = price * quantity;
    const fromCatalog = !!row?.from_catalog;
    if (fromCatalog) anyCatalog = true;

    doc.text(fromCatalog ? `${item || '—'} *` : (item || '—'), 50, y)
      .text(String(quantity || 0), 250, y)
      .text(`$${price.toFixed(2)}`, 340, y)
      .text(`$${lineTotal.toFixed(2)}`, 450, y);

    y += 20;
    if (y > 720) { // simple page break
      doc.addPage();
      y = 80;
    }
  }

  // Summary
  doc.moveTo(50, y).lineTo(550, y).stroke();
  y += 10;
  doc.text(`Subtotal: $${Number(subtotal || 0).toFixed(2)}`, 350, y, { align: 'right' });
  y += 20;
  doc.text(`Tax: $${Number(tax || 0).toFixed(2)}`, 350, y, { align: 'right' });
  y += 20;
  doc.text(`Total: $${Number(total || 0).toFixed(2)}`, 350, y, { align: 'right' });
  y += 30;

  // Catalog pricing disclaimer
  if (anyCatalog && catalogDisclaimer) {
    const dateStr = (() => {
      try {
        return new Date(catalogDisclaimer).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
      } catch {
        return catalogDisclaimer;
      }
    })();
    doc
      .fontSize(8)
      .fillColor('#777777')
      .text(
        `* Pricing marked with * was sourced from supplier catalog as of ${dateStr}. Confirm current pricing with your supplier before finalizing this quote.`,
        50, y,
        { width: 500 }
      )
      .fillColor('#000000');
  }

  doc.end();
  return done;
}

module.exports = { generateQuotePDFBuffer };
