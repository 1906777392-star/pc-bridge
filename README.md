# pc-bridge

用手机（Kelivo / 任何 MCP 客户端）通过局域网操控一台 Windows 电脑：跑命令、读写文件、把渲染结果变成手机能直接打开的链接。

典型场景：电脑连着手机热点（PC 拿到 `172.20.10.x`），手机在同一热点下直接访问电脑端口，不需要内网穿透、不需要公网服务。

## 一次性准备（在电脑上）

1. 装 Node.js 22 LTS。
2. 拉代码并装依赖：

```cmd
cd /d D:\
git clone https://github.com/1906777392-star/pc-bridge.git
cd pc-bridge
npm install
```

3. 生成令牌：

```cmd
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

4. 编辑 `start-bridge.bat`，把 `BRIDGE_TOKEN=` 后面换成上一步的串，`BRIDGE_ROOT=` 改成工作目录（默认 `D:\anim`）。
5. 双击 `start-bridge.bat`。窗口会打印手机该填的地址，形如 `http://172.20.10.3:8787/mcp`。
6. 放行防火墙（只需一次，管理员 PowerShell）：

```powershell
netsh advfirewall firewall add rule name="pc-bridge 8787" dir=in action=allow protocol=TCP localport=8787
```

## 在 Kelivo 里添加

MCP 服务器 → 添加：

- 传输类型：**HTTP**
- 服务器地址：`http://172.20.10.x:8787/mcp`（用启动窗口打印的那个）
- 自定义请求头：`Authorization` = `Bearer <你的令牌>`

保存后应能看到 5 个工具。

## 工具

| 工具 | 作用 |
| --- | --- |
| `run_command` | 跑命令（npm、python、ffmpeg、git…），返退出码与输出 |
| `read_file` | 读文本，支持按行取段、base64 |
| `write_file` | 写文本，自动建目录 |
| `list_dir` | 列目录，可递归 |
| `preview_url` | 返回手机可直接打开的 LAN 链接（视频带 Range，可拖动） |
| `system_info` | 系统/CPU/内存/LAN/Node/ffmpeg/git 是否就绪 |

渲染完一个 mp4，让它 `preview_url` 一下，手机上点开就能看。

## 注意

- **令牌就是电脑的钥匙**：`run_command` 能执行任意命令。别把 `start-bridge.bat` 发到网上，别用短令牌。
- **只在内网用**：不要在路由器上做端口映射，不要暴露到公网。
- **电脑不能睡眠**：控制面板 → 电源选项 → 把「睡眠」设为「从不」，否则热点一断就失联。
- 手机热点每次重连，电脑 IP 可能变（`172.20.10.2`…`172.20.10.14` 之间）。地址变了就在 Kelivo 里改一下；或把这个 BAT 放到启动项，开机窗口会重新打印新地址。
- 想开机自启：`Win+R` 输入 `shell:startup`，把 `start-bridge.bat` 的快捷方式丢进去。
