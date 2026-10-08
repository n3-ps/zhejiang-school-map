 # 浙江民办校作战地图
 
 浙江省民办校业务作战地图 - 用于管理浙江省民办学校的合作信息、交付项目、商机跟进等业务数据。

 截至 2026-10-08，Supabase 新加坡项目已建库并迁移 143 条业务记录（65 所学校、17 项交付、47 个商机、14 名人员）。项目地址：[pwjfxmqzdfauonrjefvn.supabase.co](https://pwjfxmqzdfauonrjefvn.supabase.co)。网页已发布，首个成员登录、学校新增与删除落库、刷新后自动恢复会话和台账均已实测通过。公开注册和匿名登录已关闭，邮箱登录已启用；匿名快照 RPC、保存 RPC、记录表查询全部拒绝访问（HTTP 401 / 42501）。

 37 项自动回归测试全部通过，数据库版本冲突与事务回滚已有验证。不同设备、两名成员同时编辑的实测尚未执行。
 
 ## 🚀 部署方式
 
 ### 方式一：GitHub Pages（推荐）
 
 1. 在 [github.com](https://github.com) 创建一个新仓库（例如 `zhejiang-battle-map`）
 2. 将本仓库代码推送到 GitHub：
 
 ```bash
 git remote add origin https://github.com/你的用户名/zhejiang-battle-map.git
 git branch -M main
 git push -u origin main
 ```
 
 3. 在 GitHub 仓库页面进入 **Settings → Pages**，来源选择 **GitHub Actions**。
 4. 工作流先运行 `node --test tests/*.test.cjs`，再执行 `node build-site.cjs`，只发布生成的 `dist` 目录。
 5. 工作流部署成功后，访问 `https://你的用户名.github.io/zhejiang-battle-map`。
 
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
 
 未配置云端时，数据存储在当前浏览器的 `localStorage` 中；修复后刷新不会清空台账。
 现有项目已经执行 [建库脚本](supabase/schema.sql)、完成迁移并填写 `cloud-config.js` 中的公开配置。多人登录所需的认证账号与成员授权按 [CLOUD_SETUP.md](CLOUD_SETUP.md) 配置；现有工作区已有 143 条记录，不应重复初次迁移。
 云端模式支持成员邮箱密码登录、保存即时提交、5 秒自动读取其他成员更新、离线暂存及逐记录版本冲突检查。初次迁移前导出最新 JSON 备份；云端同步面板可以选择该备份导入空工作区。
 发布使用 `node build-site.cjs` 生成的 `dist` 目录，GitHub Actions 已配置。云端配置生效时，发布文件排除内置业务种子与公开备份；不要直接发布整个仓库。
 校验命令：`node --test tests/*.test.cjs`。
 
 ## 📁 项目文件
 
 | 文件 | 说明 |
 |------|------|
 | `浙江民办校作战地图.html` | 主页面（单页应用，所有代码自包含） |
 | `server.js` | 本地 HTTP 服务器 |
 | `启动服务器.bat` | 一键启动本地服务器 |
