# 私人服务器部署

程序保持单进程，监听 `127.0.0.1:18780`，由 OpenResty 提供 HTTPS 和整站 HTTP Basic 密码验证。浏览器首次进入会弹出用户名、密码输入框；没有账号注册。题面、静态资源及所有 API 都经过同一道验证。请勿把后端端口开放到公网，也不要为 API 添加免登录例外。

1. 为专用域名设置 DNS，安装有效证书并配置自动续期。
2. 创建系统用户 `cfmirror`，将代码放在 `/opt/cf-mirror/current`。用系统 Python 创建环境：`uv sync --locked --no-dev --python /usr/bin/python3.12`。环境不能使用 `/root` 下的 Python，否则服务用户无法运行。
3. 创建 `/var/lib/cf-mirror`，归 `cfmirror` 所有，权限 `0700`。初次迁移数据库使用 SQLite backup，数据库权限 `0600`；密钥和数据库不放在网站静态目录。
4. 创建 root 专用的 `/etc/cf-mirror/cf-mirror.env`（`0600`）：

   ```ini
   CF_MIRROR_DATA_DIR=/var/lib/cf-mirror
   CF_MIRROR_PUBLIC_ORIGIN=https://cf.example.com
   ```

   `CF_MIRROR_PUBLIC_ORIGIN` 仅允许指定浏览器来源，**不会提供密码验证**，也不会放开后端监听地址。必须与下述网关认证同时使用。未设置时保留本机模式。

5. 安装同目录的 `cf-mirror.service` 到 `/etc/systemd/system/`，执行 `systemctl daemon-reload` 和 `systemctl enable --now cf-mirror`。
6. 参考 `openresty.conf.example` 配置独立站点。通过交互式 `htpasswd -cB /path/to/.htpasswd owner` 设置强密码，密码文件位于静态目录以外。不要在命令参数、Git 或日志中记录明文密码。1Panel 路径需与容器挂载一致。
7. 执行 OpenResty 配置校验，成功后 reload。检查未认证访问 `/`、`/settings`、`/api/config/llm`、`/static/js/app.js` 均返回 `401`；错误密码同样返回 `401`；正确账号可阅读并保存设置，跨站来源被拒绝。

应用数据与 Windows 本地数据是各自独立的副本，不会自动双向同步。迁移时会带上已有题面、模型配置和记录；之后在服务器上产生的数据应单独备份。改密码可重新运行 `htpasswd`，正常浏览器会重新要求认证；不要使用 `-c` 覆盖其他仍需保留的账号。
