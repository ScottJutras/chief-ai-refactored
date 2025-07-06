// utils/pdfService.js
const PDFDocument = require('pdfkit');
const fs = require('fs');
const axios = require('axios');

async function generateQuotePDF(quoteData, outputPath) {
    const { jobName, items, subtotal, tax, total, customerName, contractorName, companyName, companyAddress, companyPhone, logoUrl } = quoteData;
    
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    // Header with Logo and Company Info
    if (logoUrl) {
        const logoResponse = await axios.get(logoUrl, { responseType: 'arraybuffer' });
        doc.image(Buffer.from(logoResponse.data), 50, 50, { width: 100 });
    }
    doc.fontSize(12)
       .text(companyName || contractorName, 160, 50, { align: 'left' })
       .text(companyAddress || '', 160, 70)
       .text(companyPhone || '', 160, 90)
       .moveDown(2);

    // Quote Title
    doc.fontSize(20).text(`Quote for ${jobName}`, { align: 'center' })
       .moveDown();

    // Customer Info
    doc.fontSize(12).text(`Customer: ${customerName}`, { align: 'left' })
       .moveDown();

    // Items Table
    doc.fontSize(10);
    const tableTop = doc.y;
    doc.text('Item', 50, tableTop)
       .text('Quantity', 200, tableTop)
       .text('Unit Price', 300, tableTop)
       .text('Total', 400, tableTop);
    doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

    let y = tableTop + 25;
    items.forEach(({ item, quantity, price }) => {
        const lineTotal = price * quantity;
        doc.text(item, 50, y)
           .text(quantity, 200, y)
           .text(`$${price.toFixed(2)}`, 300, y)
           .text(`$${lineTotal.toFixed(2)}`, 400, y);
        y += 20;
    });

    // Summary (no markup mention)
    doc.moveTo(50, y).lineTo(550, y).stroke();
    y += 10;
    doc.text(`Subtotal: $${subtotal.toFixed(2)}`, 400, y, { align: 'right' });
    y += 20;
    doc.text(`Tax: $${tax.toFixed(2)}`, 400, y, { align: 'right' });
    y += 20;
    doc.text(`Total: $${total.toFixed(2)}`, 400, y, { align: 'right' });

    doc.end();
    return new Promise((resolve) => stream.on('finish', resolve));
}

module.exports = { generateQuotePDF };