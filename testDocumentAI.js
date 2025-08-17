const { parseUpload } = require('./services/deepDive');
     const fs = require('fs');
     async function test() {
       try {
         const buffer = fs.readFileSync('test.pdf');
         const result = await parseUpload(buffer, 'test.pdf', '1234567890', 'application/pdf');
         console.log('Result:', result);
       } catch (err) {
         console.error('Error:', err);
       }
     }
     test();