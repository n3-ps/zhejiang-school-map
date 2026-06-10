 # 浙江民办校作战地图
 
 浙江省民办校业务作战地图 - 用于管理浙江省民办学校的合作信息、交付项目、商机跟进等业务数据。
 
 ## 🚀 部署方式
 
 ### 方式一：GitHub Pages（推荐）
 
 1. 在 [github.com](https://github.com) 创建一个新仓库（例如 `zhejiang-battle-map`）
 2. 将本仓库代码推送到 GitHub：
 
 ```bash
 git remote add origin https://github.com/你的用户名/zhejiang-battle-map.git
 git branch -M main
 git push -u origin main
 ```
 
 3. 在 GitHub 仓库页面进入 **Settings → Pages**，选择 **Deploy from a branch**
 4. 分支选 `main`，目录选 `/ (root)`，点击 **Save**
 5. 等待约 1-2 分钟，访问 `https://你的用户名.github.io/zhejiang-battle-map`
 
 代码已内置 GitHub Actions 自动部署配置，推送 main 分支后会自动发布。
 
 ### 方式二：Gitee Pages（国内访问更快）
 
 1. 在 [gitee.com](https://gitee.com) 创建仓库
 2. 推送到 Gitee：
 
 ```bash
 git remote add gitee https://gitee.com/你的用户名/zhejiang-battle-map.git
 git push -u gitee main
 ```
 
 3. 在 Gitee 仓库页面进入 **服务 → Gitee Pages**，选择部署分支为 `main`
 
 ### 方式三：本地服务器 + 公网穿透
 
 服务器已经搭好，运行 `启动服务器.bat` 即可把页面托管在 `http://localhost:8080`。
 
 如果要让外网访问，可以用 Cloudflare Tunnel（免费，不需要公网 IP）：
 
 1. 下载 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
 2. 运行命令：
 
 ```bash
 cloudflared tunnel --url http://localhost:8080
 ```
 
 3. 会生成一个 `https://xxxx.trycloudflare.com` 的公开地址，分享即可访问
 
 ### 方式四：使用云存储托管（OSS）
 
 将 `浙江民办校作战地图.html` 文件上传到任意静态托管服务：
 - 阿里云 OSS + CDN
 - 腾讯云 COS + CDN
 - 七牛云对象存储
 
 ## 💾 数据说明
 
 所有数据存储在浏览器的 `localStorage` 中，不同浏览器/设备的数据相互独立。
 如需迁移数据，可在页面 **数据导入/导出** 页面导出 JSON 文件，再在其他设备导入。
 
 ## 📁 项目文件
 
 | 文件 | 说明 |
 |------|------|
 | `浙江民办校作战地图.html` | 主页面（单页应用，所有代码自包含） |
 | `server.js` | 本地 HTTP 服务器 |
 | `启动服务器.bat` | 一键启动本地服务器 |
