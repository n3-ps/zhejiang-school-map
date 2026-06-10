 const http = require('http');
 const fs = require('fs');
 const path = require('path');
 const os = require('os');
 
 const PORT = 8080;
 const HTML_FILE = '浙江民办校作战地图.html';
 
 const MIME = {
   '.html': 'text/html; charset=utf-8',
   '.js': 'application/javascript; charset=utf-8',
   '.css': 'text/css; charset=utf-8',
   '.json': 'application/json; charset=utf-8',
   '.png': 'image/png',
   '.jpg': 'image/jpeg',
   '.svg': 'image/svg+xml',
   '.ico': 'image/x-icon',
 };
 
 const server = http.createServer((req, res) => {
   let filePath = path.join(__dirname, HTML_FILE);
   if (req.url !== '/') {
     const requested = path.join(__dirname, req.url);
     if (requested.startsWith(__dirname) && fs.existsSync(requested) && fs.statSync(requested).isFile()) {
       filePath = requested;
     }
   }
   const ext = path.extname(filePath);
   res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
   fs.createReadStream(filePath).pipe(res);
 });
 
 server.listen(PORT, '0.0.0.0', () => {
   console.log('========================================');
   console.log('  浙江民办校作战地图 已启动');
   console.log('========================================');
   console.log('');
   console.log('  本机访问:');
   console.log(`  http://localhost:${PORT}`);
   console.log('');
   console.log('  局域网访问 (分享给同事):');
   const interfaces = os.networkInterfaces();
   Object.keys(interfaces).forEach(name => {
     interfaces[name].forEach(ip => {
       if (ip.family === 'IPv4' && !ip.internal) {
         console.log(`  http://${ip.address}:${PORT}  (${name})`);
       }
     });
   });
   console.log('');
   console.log('  按 Ctrl+C 停止服务器');
   console.log('========================================');
 });
