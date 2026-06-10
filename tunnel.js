const lt = require("C:/Users/hwfu/Desktop/浙江省民办校作战地图/node_modules/localtunnel");
const fs = require("fs");
const path = require("path");
const urlFile = path.join(__dirname, "tunnel-url.txt");

(async () => {
  try {
    const tunnel = await lt({ port: 8080 });
    const url = tunnel.url;
    console.log("TUNNEL_URL:" + url);
    fs.writeFileSync(urlFile, url, "utf-8");
    tunnel.on("close", () => {
      try { fs.unlinkSync(urlFile); } catch(e) {}
    });
  } catch (err) {
    console.error("TUNNEL_ERROR:" + err.message);
  }
})();
